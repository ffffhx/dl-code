import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { createAgent } from 'langchain';
import { z } from 'zod';
import { MemoryStore, type MemoryInput } from '../src/memory/MemoryStore.js';
import { MemoryRuntime } from '../src/memory/MemoryRuntime.js';
import { ToolCatalog } from '../src/tools/ToolCatalog.js';
import { createExecutionPolicy } from '../src/tools/ExecutionPolicy.js';
import { convertMCPToolToLangChain } from '../src/mcp/tool-converter.js';
import { MCPClient } from '../src/mcp/client.js';
import { MCPServerManager, getGlobalMCPManager } from '../src/mcp/manager.js';
import { CodingAgent } from '../src/agents/coding-agent.js';
import { SubagentManager } from '../src/agents/subagents/SubagentManager.js';
import { AgentJournal } from '../src/agents/subagents/AgentJournal.js';
import { ContextManager } from '../src/context/ContextManager.js';
import { ContextArtifacts } from '../src/context/ContextArtifacts.js';
import { project } from '../src/project.js';
import type { SessionContext } from '../src/session/types.js';

function fixture(t: TestContext) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-architecture-'));
  t.after(() => {
    assert.equal(path.dirname(folder), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(folder).startsWith('dl-architecture-'));
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const a = path.join(folder, 'a'); const b = path.join(folder, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  return { folder, a, b, storage: path.join(folder, 'memory') };
}
const entry = (overrides: Partial<MemoryInput> = {}): MemoryInput => ({
  id: 'auth', title: 'Authentication client', content: 'Use requestClient for authenticated requests.',
  source: 'User confirmed project convention', kind: 'fact', evidence: 'verified', ...overrides,
});
const context = (sessionId = 'root'): SessionContext => ({ sessionId, messages: [new HumanMessage('Investigate authentication')], userName: null, todos: [], createdAt: 1, updatedAt: 1 });
class ScriptModel extends BaseChatModel {
  calls = 0;
  seen: BaseMessage[][] = [];
  bound: string[][] = [];
  constructor(private respond: (messages: BaseMessage[], step: number) => AIMessage | Promise<AIMessage>) { super({}); }
  _llmType() { return 'architecture-script'; }
  bindTools(tools: any[]) { this.bound.push(tools.map(t => t.name)); return this; }
  async _generate(messages: BaseMessage[]) {
    this.seen.push(messages);
    return { generations: [{ text: '', message: await this.respond(messages, this.calls++) }] };
  }
}

test('memory survives new sessions, isolates projects and recalls shared user preferences', t => {
  const f = fixture(t);
  const a = new MemoryStore(f.a, f.storage);
  a.upsert(entry());
  a.upsert(entry({ id: 'language', scope: 'user', kind: 'preference', evidence: 'user_stated', content: 'Answer in Chinese' }));
  assert.equal(new MemoryStore(f.a, f.storage).search('authentication').length, 2);
  const other = new MemoryStore(f.b, f.storage).search('authentication');
  assert.deepEqual(other.map(r => r.id), ['language']);
  assert.match(fs.readFileSync(path.join(f.storage, fs.readdirSync(f.storage).find(n => n.startsWith('project-'))!, 'auth.md'), 'utf8'), /requestClient/);
});

test('memory updates require revisions, reject duplicates and retire obsolete facts', t => {
  const f = fixture(t); const store = new MemoryStore(f.a, f.storage);
  const saved = store.upsert(entry());
  assert.throws(() => store.upsert(entry()), /revision conflict/);
  assert.throws(() => store.upsert(entry({ id: 'duplicate' })), /Duplicate memory/);
  const next = store.upsert(entry({ content: 'Use the new authClient.', expectedRevision: saved.revision }));
  assert.throws(() => store.invalidate('project', 'auth', saved.revision, 'obsolete'), /revision conflict/);
  const retired = store.invalidate('project', 'auth', next.revision, 'API removed');
  assert.ok(retired.stale);
  assert.equal(store.search('auth').length, 0);
  assert.equal(store.read('project', 'auth').invalidated, 'API removed');
});

test('memory filters expiration, hypotheses and changed or deleted source files', t => {
  const f = fixture(t); let now = 100;
  const store = new MemoryStore(f.a, f.storage, () => now);
  fs.writeFileSync(path.join(f.a, 'auth.ts'), 'version one');
  store.upsert(entry({ sourceFile: 'auth.ts' }));
  store.upsert(entry({ id: 'temporary', content: 'Temporary API compatibility', expiresAt: 200 }));
  store.upsert(entry({ id: 'guess', content: 'Might be a race', evidence: 'hypothesis' }));
  assert.equal(store.search('').length, 2);
  fs.writeFileSync(path.join(f.a, 'auth.ts'), 'version two'); now = 201;
  assert.equal(store.search('').length, 0);
  assert.ok(store.read('project', 'auth').stale);
  fs.unlinkSync(path.join(f.a, 'auth.ts'));
  assert.ok(store.read('project', 'auth').stale);
  assert.throws(() => store.upsert(entry({ id: '../escape' })), /Invalid/);
});

test('memory bounds prompt recall, reports damaged entries and prevents read-only writes', t => {
  const f = fixture(t); const store = new MemoryStore(f.a, f.storage);
  store.upsert(entry({ content: 'authentication '.repeat(350) }));
  const runtime = new MemoryRuntime(store, true);
  assert.ok(runtime.prompt('authentication', 2000).length <= 2000);
  assert.deepEqual(runtime.tools().map(t => t.name), ['search_memory', 'read_memory']);
  const folder = path.join(f.storage, fs.readdirSync(f.storage)[0]);
  fs.writeFileSync(path.join(folder, 'broken.md'), 'invalid');
  assert.match(runtime.prompt('authentication'), /could not be read/);
});

test('CodingAgent recalls persisted project memory and can save through the real tool loop', async t => {
  const f = fixture(t);
  const store = new MemoryStore(project.rootDir, f.storage);
  store.upsert(entry({ content: 'Authentication marker CROSS_SESSION_MEMORY' }));
  const model = new ScriptModel((messages, step) => {
    assert.match(String(messages[0].content), /CROSS_SESSION_MEMORY/);
    if (!step) return new AIMessage({ content: '', tool_calls: [{ id: 'save', name: 'save_memory', args: entry({ id: 'new-rule', content: 'Authentication marker NEW_MEMORY' }) }] });
    assert.match(String(messages[0].content), /NEW_MEMORY/);
    return new AIMessage('Done');
  });
  const agent = new CodingAgent([], { model, memoryDirectory: f.storage });
  try { for await (const _ of agent.execute(context())) void _; } finally { await agent.cleanup(); }
  assert.match(new MemoryStore(project.rootDir, f.storage).read('project', 'new-rule').content, /NEW_MEMORY/);
});

test('MCP keeps JSON Schema and rejects enum, integer, oneOf and local-ref violations before side effects', async () => {
  let calls = 0;
  const manager = { callTool: async () => { calls++; return { content: [{ type: 'text', text: 'ok' }] }; } } as unknown as MCPServerManager;
  const schema = { type: 'object' as const, additionalProperties: false, required: ['mode', 'count', 'value'],
    properties: { mode: { enum: ['read', 'write'] }, count: { type: 'integer', minimum: 1 }, value: { $ref: '#/$defs/value' } },
    $defs: { value: { oneOf: [{ type: 'string', minLength: 2 }, { type: 'integer' }] } } };
  const tool = convertMCPToolToLangChain('demo', { name: 'query', inputSchema: schema }, manager);
  assert.deepEqual(tool.schema, schema);
  for (const input of [{ mode: 'bad', count: 1, value: 'ok' }, { mode: 'read', count: 1.5, value: 'ok' }, { mode: 'read', count: 1, value: true }, { mode: 'read', count: 1, value: 'ok', extra: 1 }]) {
    await assert.rejects(tool.invoke(input));
  }
  assert.equal(calls, 0);
  assert.equal(await tool.invoke({ mode: 'read', count: 2, value: 'ok' }), 'ok');
  assert.equal(calls, 1);
});

test('external tools are absent until loaded, executable on the next request, and removed on unload', async t => {
  const f = fixture(t); let calls = 0;
  const mcp = getGlobalMCPManager();
  const oldList = mcp.getAllTools; const oldCount = mcp.getServerCount; const oldCall = mcp.callTool;
  mcp.getServerCount = () => 1;
  mcp.getAllTools = async () => [{ serverName: 'demo', tool: { name: 'deploy', description: 'Find preview deployment', inputSchema: { type: 'object', properties: {}, additionalProperties: false } } }];
  mcp.callTool = async () => { calls++; return { content: [{ type: 'text', text: 'DEPLOYMENT_RESULT' }] }; };
  const model = new ScriptModel((_messages, step) => {
    const name = 'mcp_demo_deploy'; const bound = model.bound.at(-1)!;
    if (step === 0) { assert.ok(!bound.includes(name)); return new AIMessage({ content: '', tool_calls: [{ id: 'search', name: 'search_tools', args: { query: 'deployment' } }] }); }
    if (step === 1) { assert.ok(!bound.includes(name)); assert.equal(calls, 0); return new AIMessage({ content: '', tool_calls: [{ id: 'load', name: 'load_tools', args: { names: [name] } }] }); }
    if (step === 2) { assert.ok(bound.includes(name)); return new AIMessage({ content: '', tool_calls: [{ id: 'call', name, args: {} }] }); }
    if (step === 3) { assert.equal(calls, 1); return new AIMessage({ content: '', tool_calls: [{ id: 'unload', name: 'unload_tools', args: { names: [name] } }] }); }
    assert.ok(!bound.includes(name)); return new AIMessage('Done');
  });
  const agent = new CodingAgent([], { model, memoryDirectory: f.storage });
  try { for await (const _ of agent.execute(context())) void _; }
  finally { await agent.cleanup(); mcp.getAllTools = oldList; mcp.getServerCount = oldCount; mcp.callTool = oldCall; }
  assert.equal(calls, 1); assert.equal(model.calls, 5);
});

test('catalog rejects duplicate names and atomic over-capacity activation', () => {
  const tool = (name: string) => new DynamicStructuredTool({ name, description: name, schema: z.object({}), func: async () => 'ok' });
  assert.throws(() => new ToolCatalog([tool('a'), tool('a')]), /Duplicate/);
  const catalog = new ToolCatalog([tool('a'), tool('b')], 1);
  assert.throws(() => catalog.load(['a', 'b']), /At most/);
  assert.equal(catalog.definitions().length, 0);
});

test('tool budget blocks an additional write and deadline propagates cancellation', async () => {
  let writes = 0;
  const write = new DynamicStructuredTool({ name: 'write', description: 'count writes', schema: z.object({}), func: async () => { writes++; return 'ok'; } });
  const controller = new AbortController();
  const model = new ScriptModel((_m, step) => new AIMessage({ content: '', tool_calls: [{ id: `write-${step}`, name: 'write', args: {} }] }));
  const agent = createAgent({ model, tools: [write], middleware: [createExecutionPolicy(controller, { maxToolCalls: 1 })] });
  await assert.rejects(agent.invoke({ messages: [new HumanMessage('write')] }, { signal: controller.signal }));
  assert.equal(writes, 1);
  let observed = false; const records: string[] = [];
  const waiting = new DynamicStructuredTool({ name: 'wait', description: 'wait', schema: z.object({}), func: async (_input, _run, config) => {
    await new Promise((resolve, reject) => {
      const abort = () => { observed = true; reject(config?.signal?.reason); };
      config?.signal?.addEventListener('abort', abort, { once: true });
      if (config?.signal?.aborted) abort();
      void resolve;
    }); return 'unexpected';
  } });
  const deadline = new AbortController();
  const waiter = createAgent({ model: new ScriptModel(() => new AIMessage({ content: '', tool_calls: [{ id: 'wait', name: 'wait', args: {} }] })), tools: [waiting],
    middleware: [createExecutionPolicy(deadline, { toolTimeoutMs: 30 }, r => records.push(r.status))] });
  await assert.rejects(waiter.invoke({ messages: [new HumanMessage('wait')] }, { signal: deadline.signal }));
  assert.ok(observed); assert.deepEqual(records, ['running', 'unknown']);
});

test('MCP stdio handles split Unicode, pagination and caller cancellation', { timeout: 5000 }, async t => {
  const f = fixture(t); const script = path.join(f.folder, 'server.cjs');
  fs.writeFileSync(script, `const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const r=JSON.parse(line); if(r.id===undefined)return;
let result;if(r.method==='initialize') result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
else if(r.method==='tools/list')result=r.params?.cursor?{tools:[{name:'第二个',inputSchema:{type:'object'}}]}:{tools:[{name:'first',inputSchema:{type:'object'}}],nextCursor:'page2'};
else return;
const b=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');for(const byte of b)process.stdout.write(Buffer.from([byte]));});`);
  const client = new MCPClient({ command: process.execPath, args: [script] });
  try {
    await client.connect(); assert.deepEqual((await client.listTools()).map(t => t.name), ['first', '第二个']);
    const controller = new AbortController(); const pending = client.callTool('wait', {}, controller.signal);
    controller.abort(new Error('cancel fixture'));
    await assert.rejects(pending, /cancel fixture/);
  } finally { await client.disconnect(); }
});

test('dependent work needs accepted evidence, receives inputs, and freezes its prerequisites', async t => {
  const f = fixture(t); const seen: string[] = [];
  const manager = new SubagentManager('root', new AgentJournal(path.join(f.folder, 'journal')), () => ({
    run: async c => { seen.push(String(c.messages[0].content)); return 'Verified auth evidence'; }, cleanup() {},
  }));
  manager.attachRoot(context());
  try {
    const a = manager.spawn('Inspect API', '', { acceptanceCriteria: 'Cite API file' });
    await manager.wait(a.id, 1000);
    assert.throws(() => manager.spawn('Follow up', '', { dependsOn: [a.id] }), /accepted/);
    manager.review(a.id, false, 'Missing file');
    assert.throws(() => manager.spawn('Follow up', '', { dependsOn: [a.id] }), /accepted/);
    manager.review(a.id, true, 'Checked auth.ts against returned evidence');
    const b = manager.spawn('Follow up', '', { dependsOn: [a.id] });
    await manager.wait(b.id, 1000);
    assert.match(seen[1], /Verified auth evidence/);
    assert.throws(() => manager.sendMessage(a.id, 'change evidence'), /dependent/);
    assert.throws(() => manager.review(a.id, false, 'changed'), /dependent/);
  } finally { await manager.shutdown(); }
  const recovered = new SubagentManager('root', new AgentJournal(path.join(f.folder, 'journal')), () => { throw new Error('must not run'); });
  assert.ok(recovered.list().some(r => r.review?.status === 'accepted'));
  await recovered.shutdown();
});

test('MCP HTTP negotiates session, acknowledges initialization and reads SSE response frames', async () => {
  let initialized = false;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    assert.match(req.headers.accept!, /text\/event-stream/);
    if (message.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } } }));
    } else {
      assert.equal(req.headers['mcp-session-id'], 'fixture-session');
      assert.equal(req.headers['mcp-protocol-version'], '2025-03-26');
      if (message.method === 'notifications/initialized') { initialized = true; res.writeHead(202); res.end(); return; }
      assert.ok(initialized);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': heartbeat\r\n\r\n');
      res.write('data: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n');
      const result = { content: [{ type: 'text', text: '流式结果' }] };
      const text = `event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\r\n\r\n`;
      const bytes = Buffer.from(text); res.write(bytes.subarray(0, bytes.length - 5)); res.end(bytes.subarray(bytes.length - 5));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const client = new MCPClient({ transport: 'streamable_http', url: `http://127.0.0.1:${address.port}` });
  try { await client.connect(); assert.equal((await client.callTool('query', {})).content[0].text, '流式结果'); }
  finally { await client.disconnect(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('duplicate-read pruning keeps original history, protocol pairs, changed results and writes', async t => {
  const f = fixture(t); const manager = new ContextManager({ maxTokens: 20000, toolOutputTokens: 10000 });
  const artifacts = new ContextArtifacts('dedup', f.folder);
  const output = 'important evidence '.repeat(200);
  const messages: BaseMessage[] = [new HumanMessage('Investigate')];
  for (const [id, name, content] of [['a', 'read_file', output], ['b', 'read_file', output], ['c', 'read_file', output + 'changed'], ['d', 'write_file', output]]) {
    messages.push(new AIMessage({ content: '', tool_calls: [{ id, name, args: { path: 'auth.ts' } }] }), new ToolMessage({ tool_call_id: id, content }));
  }
  try {
    const result = await manager.manageContext(messages, { artifacts });
    assert.equal(messages[2].content, output);
    assert.match(String(result.messages[2].content), /Exact repeated read omitted/);
    assert.equal(result.messages[4].content, output);
    assert.equal(result.messages[6].content, output + 'changed');
    assert.equal(result.messages[8].content, output);
    assert.equal(result.messages.length, messages.length);
  } finally { manager.cleanup(); }
});
