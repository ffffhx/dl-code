import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SubagentManager } from '../src/agents/subagents/SubagentManager.js';
import { AgentJournal } from '../src/agents/subagents/AgentJournal.js';
import { createSubagentTools } from '../src/agents/subagents/tools.js';
import type { AgentRecord, RunnerFactory } from '../src/agents/subagents/types.js';
import type { SessionContext } from '../src/session/types.js';
import { CodingAgent } from '../src/agents/coding-agent.js';
import { BashTerminal } from '../src/tools/terminal/bash-terminal.js';
import { createReadOnlyTools } from '../src/tools/read-only.js';
import { getGlobalMCPManager } from '../src/mcp/index.js';

function fixture(t: TestContext) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-agents-test-'));
  t.after(() => {
    assert.ok(path.basename(folder).startsWith('dl-agents-test-'));
    assert.equal(path.dirname(folder), fs.realpathSync(os.tmpdir()));
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const root: SessionContext = { sessionId: 'root', messages: [new HumanMessage('parent private history')], userName: null, todos: [], activeSkills: [], createdAt: 1, updatedAt: 1 };
  return { folder, root, journal: new AgentJournal(folder) };
}

const abortableDelay = (signal: AbortSignal, ms = 10000) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
});

test('two children run independently, return immediately, enforce capacity and cancel without affecting sibling', async t => {
  const f = fixture(t);
  const seen: SessionContext[] = [];
  const cleaned: string[] = [];
  const factory: RunnerFactory = record => ({
    run: async (context, control) => {
      seen.push(context); control.takeMessages();
      await abortableDelay(control.signal, record.task === 'quick' ? 80 : 10000);
      return record.task;
    }, cleanup: () => { cleaned.push(record.id); },
  });
  const manager = new SubagentManager('root', f.journal, factory);
  manager.attachRoot(f.root);
  const quick = manager.spawn('quick', 'explicit background');
  const slow = manager.spawn('slow');
  assert.equal(quick.status, 'running');
  assert.throws(() => manager.spawn('third'), /At most 2/);
  assert.equal((await manager.wait(slow.id, 0)).status, 'running');
  assert.equal((await manager.cancel(slow.id)).status, 'cancelled');
  assert.equal((await manager.wait(quick.id, 1000)).result, 'quick');
  assert.equal(cleaned.length, 2);
  assert.notEqual(seen[0].messages, seen[1]?.messages);
  assert.ok(seen.every(c => !JSON.stringify(c.messages).includes('parent private history')));
  assert.equal(manager.takeMessages('root').length, 2);
  assert.equal(manager.takeMessages('root').length, 0);
  assert.throws(() => manager.sendMessage('root', 'bad'), /direct child/);
  await manager.shutdown();
});

test('mail is delivered exactly once and explicit follow-up reuses the child history', async t => {
  const f = fixture(t);
  const delivered: string[] = [];
  let calls = 0;
  const manager = new SubagentManager('root', f.journal, () => ({
    run: async (context, control) => {
      calls++;
      delivered.push(...control.takeMessages().map(m => String(m.content)));
      context.messages.push(new AIMessage(`answer-${calls}`));
      control.onContextChange(context);
      return `answer-${calls}`;
    }, cleanup: () => {},
  }));
  manager.attachRoot(f.root);
  const child = manager.spawn('review');
  manager.sendMessage(child.id, 'look at Table.tsx');
  await manager.wait(child.id, 1000);
  assert.equal(delivered.length, 1);
  manager.sendMessage(child.id, 'now explain the fix');
  assert.equal((await manager.wait(child.id, 1000)).result, 'answer-2');
  assert.equal(delivered.length, 2);
  const saved = f.journal.load().find(r => r.id === child.id)!;
  assert.equal(saved.context.messages.filter(m => m._getType() === 'ai').length, 2);
  assert.deepEqual(saved.inbox, []);
  await manager.shutdown();
});

test('journal recovers interrupted children and pending mail, repairs dangling tool calls without replay', async t => {
  const f = fixture(t);
  const record: AgentRecord = {
    id: 'child', parentId: 'root', task: 'unfinished', status: 'running',
    context: { ...f.root, sessionId: 'child', messages: [new AIMessage({ content: '', tool_calls: [{ id: 'tool-1', name: 'read_file', args: { path: 'x' } }] })] },
    inbox: [{ id: 'mail-1', from: 'root', text: 'pending', createdAt: 1 }],
  };
  f.journal.save(record, 'started');
  fs.appendFileSync(path.join(f.folder, 'child', 'events.jsonl'), '{unfinished');
  let ran = false;
  const manager = new SubagentManager('root', new AgentJournal(f.folder), () => ({
    run: async (context, control) => {
      ran = true;
      assert.ok(context.messages.some(m => m instanceof ToolMessage && m.tool_call_id === 'tool-1'));
      assert.equal(control.takeMessages().length, 2);
      return 'resumed explicitly';
    }, cleanup: () => {},
  }));
  assert.equal(manager.inspect('child').status, 'interrupted');
  assert.equal(ran, false);
  manager.attachRoot(f.root);
  manager.sendMessage('child', 'continue');
  assert.equal((await manager.wait('child', 1000)).status, 'completed');
  assert.ok(new AgentJournal(f.folder).load().length >= 2);
  await manager.shutdown();
});

test('failure settles waiters and releases capacity; shutdown aborts all active children', async t => {
  const f = fixture(t);
  const manager = new SubagentManager('root', f.journal, record => ({
    run: async (_context, control) => {
      if (record.task === 'fail') throw new Error('model failure');
      await abortableDelay(control.signal); return 'unexpected';
    }, cleanup: () => {},
  }));
  manager.attachRoot(f.root);
  const failed = manager.spawn('fail');
  assert.match((await manager.wait(failed.id, 1000)).error!, /model failure/);
  const a = manager.spawn('a'); const b = manager.spawn('b');
  await Promise.resolve();
  await manager.shutdown();
  assert.equal(manager.inspect(a.id).status, 'cancelled');
  assert.equal(manager.inspect(b.id).status, 'cancelled');
  assert.throws(() => manager.spawn('late'), /shutting down/);
});

test('cancelling a wait does not cancel the child', async t => {
  const f = fixture(t);
  const manager = new SubagentManager('root', f.journal, () => ({ run: async (_c, control) => { await abortableDelay(control.signal); return ''; }, cleanup: () => {} }));
  manager.attachRoot(f.root);
  const child = manager.spawn('wait');
  const controller = new AbortController();
  const waiting = manager.wait(child.id, 60000, controller.signal);
  controller.abort(new Error('stop waiting'));
  await assert.rejects(waiting, /stop waiting/);
  assert.equal(manager.inspect(child.id).status, 'running');
  await manager.cancel(child.id);
  await manager.shutdown();
});

class ScriptedModel extends BaseChatModel {
  requests: BaseMessage[][] = [];
  boundNames: string[] = [];
  onRequest?: () => void;
  constructor(private replies: AIMessage[]) { super({}); }
  _llmType() { return 'subagent-test'; }
  bindTools(tools: Array<{ name: string }>) { this.boundNames = tools.map(t => t.name); return this; }
  async _generate(messages: BaseMessage[]) {
    this.requests.push(messages); this.onRequest?.();
    const message = this.replies.shift(); assert.ok(message);
    return { generations: [{ text: '', message }] };
  }
}

test('real CodingAgent child reads a file, receives mail at next model boundary, has no write/MCP/spawn tools', async t => {
  const f = fixture(t);
  const file = path.join(f.folder, 'source.txt'); fs.writeFileSync(file, 'SOURCE_EVIDENCE');
  const model = new ScriptedModel([
    new AIMessage({ content: '', tool_calls: [{ id: 'read', name: 'read_file', args: { path: file } }] }),
    new AIMessage('Final review'),
  ]);
  const childAgent = new CodingAgent([], { readOnly: true, model });
  const manager = new SubagentManager('root', f.journal, () => ({
    run: async (context, control) => {
      for await (const _ of childAgent.execute(context, control.onContextChange, control)) { /* stream */ }
      return String(context.messages.at(-1)?.content);
    }, cleanup: () => childAgent.cleanup(),
  }));
  manager.attachRoot(f.root);
  const child = manager.spawn('inspect');
  model.onRequest = () => { if (model.requests.length === 1) manager.sendMessage(child.id, 'MAIL_BOUNDARY_MARKER'); };
  assert.equal((await manager.wait(child.id, 3000)).result, 'Final review');
  assert.equal(model.requests.length, 2);
  assert.ok(!JSON.stringify(model.requests[0]).includes('MAIL_BOUNDARY_MARKER'));
  assert.ok(JSON.stringify(model.requests[1]).includes('MAIL_BOUNDARY_MARKER'));
  assert.ok(JSON.stringify(model.requests[1]).includes('SOURCE_EVIDENCE'));
  for (const forbidden of ['bash', 'text_editor', 'todo_write', 'spawn_agent']) assert.ok(!model.boundNames.includes(forbidden));
  assert.ok(!model.boundNames.some(name => name.startsWith('mcp_')));
  const restored = new AgentJournal(f.folder).load().find(r => r.id === child.id)!;
  assert.equal(restored.context.messages.filter(m => String(m.content).includes('MAIL_BOUNDARY_MARKER')).length, 1);
  await manager.shutdown();
});

test('subagent tools expose asynchronous task lifecycle and errors as tool results', async t => {
  const f = fixture(t);
  const manager = new SubagentManager('root', f.journal, () => ({ run: async () => 'summary', cleanup: () => {} }));
  manager.attachRoot(f.root);
  const tools = createSubagentTools(manager);
  const created = JSON.parse(await tools[0].invoke({ task: 'summarize' }));
  const result = JSON.parse(await tools[1].invoke({ id: created.id, timeout_ms: 1000 }));
  assert.equal(result.result, 'summary');
  assert.match(await tools[3].invoke({ id: 'unknown' }), /Subagent error/);
  await manager.shutdown();
});

test('child cleanup never disconnects application-owned MCP connections', async () => {
  const mcp = getGlobalMCPManager();
  const original = mcp.disconnectAll;
  let disconnected = false;
  mcp.disconnectAll = async () => { disconnected = true; };
  try {
    const child = new CodingAgent([], { readOnly: true, model: new ScriptedModel([]) });
    await child.cleanup();
    assert.equal(disconnected, false);
  } finally { mcp.disconnectAll = original; }
});

test('read-only grep treats shell syntax as data and accepts cancellation', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.folder, 'file.txt'), 'plain source');
  const grep = createReadOnlyTools(f.folder).find(tool => tool.name === 'grep')!;
  const marker = path.join(f.folder, 'injected');
  await grep.invoke({ pattern: `plain & echo hacked > "${marker}"`, path: f.folder });
  assert.equal(fs.existsSync(marker), false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(grep.invoke({ pattern: 'plain', path: f.folder }, { signal: controller.signal }));
});

test('independent real shells keep cwd and environment separate; cancelling one leaves the other alive', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const aDir = path.join(f.folder, 'a'); const bDir = path.join(f.folder, 'b');
  fs.mkdirSync(aDir); fs.mkdirSync(bDir);
  const a = new BashTerminal(aDir); const b = new BashTerminal(bDir);
  try {
    const windows = process.platform === 'win32';
    assert.match(await a.execute(windows ? "$env:DL_TEST_VALUE='only-a'; (Get-Location).Path" : 'export DL_TEST_VALUE=only-a; pwd', 5000), /[\\/]a/);
    assert.match(await b.getcwd(), /[\\/]b/);
    assert.ok(!(await b.execute(windows ? '$env:DL_TEST_VALUE' : 'printf "%s" "$DL_TEST_VALUE"')).includes('only-a'));
    const controller = new AbortController();
    const waiting = a.execute(windows ? 'Start-Sleep -Seconds 60' : 'sleep 60', 10000, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(waiting, /cancelled/);
    await a.close();
    assert.match(await b.execute(windows ? "Write-Output 'still-alive'" : 'echo still-alive'), /still-alive/);
  } finally { await Promise.all([a.close(), b.close()]); }
});

test('a real main Agent delegates two parallel children and collects their results', async t => {
  const f = fixture(t);
  const childModels: ScriptedModel[] = [];
  const manager = new SubagentManager('root', f.journal, record => {
    const model = new ScriptedModel([new AIMessage(`Evidence for ${record.task}`)]);
    childModels.push(model);
    const agent = new CodingAgent([], { readOnly: true, model });
    return { run: async (context, control) => {
      for await (const chunk of agent.execute(context, control.onContextChange, control)) void chunk;
      return String(context.messages.at(-1)?.content);
    }, cleanup: () => agent.cleanup() };
  });
  class ParentModel extends BaseChatModel {
    count = 0;
    _llmType() { return 'parent-test'; }
    bindTools() { return this; }
    async _generate(messages: BaseMessage[]) {
      this.count++;
      let message: AIMessage;
      if (this.count === 1) message = new AIMessage({ content: '', tool_calls: [
        { name: 'spawn_agent', id: 'spawn-a', args: { task: 'entry points' } },
        { name: 'spawn_agent', id: 'spawn-b', args: { task: 'test coverage' } },
      ] });
      else if (this.count === 2) {
        const ids = messages.filter(m => m._getType() === 'tool').map(m => JSON.parse(String(m.content)).id);
        assert.equal(ids.length, 2);
        message = new AIMessage({ content: '', tool_calls: ids.map((id, i) => ({ name: 'wait_agent', id: `wait-${i}`, args: { id, timeout_ms: 2000 } })) });
      } else {
        assert.ok(JSON.stringify(messages).includes('Evidence for entry points'), JSON.stringify(messages.filter(m => m._getType() !== 'system').map(m => m.content)));
        assert.ok(JSON.stringify(messages).includes('Evidence for test coverage'), JSON.stringify(manager.list()));
        message = new AIMessage('Combined review');
      }
      return { generations: [{ text: '', message }] };
    }
  }
  manager.attachRoot(f.root);
  const parent = new CodingAgent([], { model: new ParentModel({}) });
  try {
    for await (const chunk of parent.execute(f.root, context => manager.update('root', context), {
      tools: createSubagentTools(manager), takeMessages: () => manager.takeMessages('root'),
    })) void chunk;
    assert.equal(f.root.messages.at(-1)?.content, 'Combined review');
    assert.equal(childModels.length, 2);
    assert.ok(manager.list().filter(r => r.parentId).every(r => r.status === 'completed'));
    assert.ok(childModels.every(model => !JSON.stringify(model.requests).includes('parent private history')));
  } finally { await manager.shutdown(); await parent.cleanup(); }
});

test('cancellation reaches an actual child model request and prevents additional tool work', async t => {
  const f = fixture(t);
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  let observedAbort = false;
  class WaitingModel extends BaseChatModel {
    _llmType() { return 'waiting-test'; }
    bindTools() { return this; }
    async _generate(_messages: BaseMessage[], options: { signal?: AbortSignal }) {
      assert.ok(options.signal); started();
      try { await abortableDelay(options.signal); } catch (error) { observedAbort = true; throw error; }
      return { generations: [{ text: '', message: new AIMessage('must not happen') }] };
    }
  }
  const manager = new SubagentManager('root', f.journal, () => {
    const agent = new CodingAgent([], { readOnly: true, model: new WaitingModel({}) });
    return { run: async (context, control) => {
      for await (const chunk of agent.execute(context, control.onContextChange, control)) void chunk;
      return 'unexpected';
    }, cleanup: () => agent.cleanup() };
  });
  manager.attachRoot(f.root);
  const child = manager.spawn('wait for model');
  await requestStarted;
  assert.equal((await manager.cancel(child.id)).status, 'cancelled');
  assert.equal(observedAbort, true);
  assert.equal(manager.inspect(child.id).result, undefined);
  await manager.shutdown();
});

test('two live managers cannot own the same journal, and orderly shutdown releases ownership', async t => {
  const f = fixture(t);
  const factory: RunnerFactory = () => ({ run: async () => '', cleanup: () => {} });
  const first = new SubagentManager('root', f.journal, factory);
  assert.throws(() => new SubagentManager('root', new AgentJournal(f.folder), factory), /already managed/);
  await first.shutdown();
  const second = new SubagentManager('root', new AgentJournal(f.folder), factory);
  await second.shutdown();
});
