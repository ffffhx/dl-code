import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createAgent } from 'langchain';
import { SkillManager } from '../src/skills/SkillManager.js';
import { SkillRuntime } from '../src/skills/SkillRuntime.js';
import { createSkillMiddleware } from '../src/skills/middleware.js';
import { ContextManager } from '../src/context/ContextManager.js';
import { SessionManager } from '../src/session/SessionManager.js';
import { useAppStore } from '../src/store/app-store.js';
import type { SessionContext } from '../src/session/types.js';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-skills-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('dl-skills-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const userRoot = path.join(root, 'user');
  const projectRoot = path.join(root, 'project');
  const projectSkills = path.join(projectRoot, '.dl-code', 'skills');
  const write = (scope: 'user' | 'project', folder: string, body = 'BODY_ONLY_MARKER', name = folder) => {
    const dir = path.join(scope === 'user' ? userRoot : projectSkills, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Review code carefully\n---\n${body}`);
    return dir;
  };
  const manager = new SkillManager(projectRoot, userRoot);
  const context: SessionContext = { sessionId: 'test', messages: [], userName: null, todos: [], createdAt: 1, updatedAt: 1 };
  return { root, projectRoot, userRoot, write, manager, context };
}

test('discovery indexes metadata only, applies project overrides, skips malformed and duplicate entries', t => {
  const f = fixture(t);
  f.write('user', 'review', 'USER_BODY');
  const winner = f.write('project', 'review', 'PROJECT_BODY');
  f.write('project', 'zz-duplicate', 'DUPLICATE', 'review');
  const invalid = f.write('project', 'invalid');
  fs.writeFileSync(path.join(invalid, 'SKILL.md'), 'missing frontmatter');
  const list = f.manager.discover();
  assert.equal(list.length, 1);
  assert.equal(list[0].directory, fs.realpathSync(winner));
  assert.equal(list[0].source, 'project');
  assert.ok(!JSON.stringify(list).includes('PROJECT_BODY'));
  assert.equal(f.manager.warnings.length, 2);
  assert.equal(f.manager.load('review').body, 'PROJECT_BODY');
});

test('unknown names and missing skill roots are handled without arbitrary file loading', t => {
  const f = fixture(t);
  assert.deepEqual(f.manager.discover(), []);
  assert.throws(() => f.manager.load('../../secret'), /Unknown skill/);
});

test('load is on demand, idempotent, persists refs, and unload stops reinjection', async t => {
  const f = fixture(t);
  f.write('project', 'review');
  f.manager.discover();
  let saved = 0;
  const runtime = new SkillRuntime(f.manager, f.context, () => saved++);
  const [load, , unload] = runtime.tools();
  assert.ok(!runtime.prompt().includes('BODY_ONLY_MARKER'));
  assert.match(await load.invoke({ name: 'review' }), /BODY_ONLY_MARKER/);
  await load.invoke({ name: 'review' });
  assert.equal(f.context.activeSkills?.length, 1);
  assert.equal(f.context.activeSkills?.[0].hash.length, 64);
  assert.ok(runtime.prompt().includes('BODY_ONLY_MARKER'));
  assert.equal(saved, 2);
  await unload.invoke({ name: 'review' });
  assert.ok(!runtime.prompt().includes('BODY_ONLY_MARKER'));
  assert.deepEqual(f.context.activeSkills, []);
  assert.match(await load.invoke({ name: 'missing' }), /Skill error/);
});

test('resources resolve against the skill directory; traversal, absolute and symlink escapes fail', async t => {
  const f = fixture(t);
  const dir = f.write('project', 'review');
  fs.mkdirSync(path.join(dir, 'references'));
  fs.writeFileSync(path.join(dir, 'references', 'check.md'), 'reference text');
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.md'), 'outside');
  fs.symlinkSync(outside, path.join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  f.manager.discover();
  const [load, read] = new SkillRuntime(f.manager, f.context).tools();
  assert.match(await read.invoke({ name: 'review', path: 'references/check.md' }), /Load the skill/);
  await load.invoke({ name: 'review' });
  assert.match(await read.invoke({ name: 'review', path: 'references/check.md' }), /reference text/);
  for (const resource of ['../secret.md', path.join(outside, 'secret.md'), 'linked/secret.md']) {
    assert.match(await read.invoke({ name: 'review', path: resource }), /Skill error/);
  }
});

test('scripts are read as text and never executed during discovery or load', async t => {
  const f = fixture(t);
  const dir = f.write('project', 'review', 'Read scripts/check.mjs');
  fs.mkdirSync(path.join(dir, 'scripts'));
  const marker = path.join(f.root, 'executed');
  fs.writeFileSync(path.join(dir, 'scripts', 'check.mjs'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`);
  f.manager.discover();
  const [load, read] = new SkillRuntime(f.manager, f.context).tools();
  await load.invoke({ name: 'review' });
  await read.invoke({ name: 'review', path: 'scripts/check.mjs' });
  assert.equal(fs.existsSync(marker), false);
});

test('changed, deleted or differently scoped skills deactivate on resume', async t => {
  const f = fixture(t);
  const dir = f.write('user', 'review');
  f.manager.discover();
  const original = new SkillRuntime(f.manager, f.context);
  await original.tools()[0].invoke({ name: 'review' });
  const saved = JSON.parse(JSON.stringify(f.context));
  fs.appendFileSync(path.join(dir, 'SKILL.md'), '\nCHANGED_BODY');
  const resumed = new SkillRuntime(f.manager, f.context);
  assert.match(resumed.prompt(), /deactivated/);
  assert.ok(!resumed.prompt().includes('CHANGED_BODY'));
  assert.deepEqual(f.context.activeSkills, []);
  await resumed.tools()[0].invoke({ name: 'review' });
  assert.match(resumed.prompt(), /CHANGED_BODY/);
  fs.unlinkSync(path.join(dir, 'SKILL.md'));
  assert.match(resumed.prompt(), /deactivated/);
  f.write('project', 'review', 'PROJECT_REPLACEMENT');
  f.manager.discover();
  const differentProject = new SkillRuntime(f.manager, saved);
  assert.ok(!differentProject.prompt().includes('PROJECT_REPLACEMENT'));
  assert.deepEqual(saved.activeSkills, []);
});

test('oversized instructions and binary resources are rejected', t => {
  const f = fixture(t);
  f.write('user', 'huge', 'x'.repeat(129 * 1024));
  const dir = f.write('project', 'review');
  fs.writeFileSync(path.join(dir, 'binary'), Buffer.from([0, 1, 2]));
  assert.equal(f.manager.discover().length, 1);
  assert.equal(f.manager.warnings.length, 1);
  assert.throws(() => f.manager.readResource('review', 'binary'), /Invalid/);
});

test('session JSON and Zustand round-trip active refs and tool call identifiers, clearing releases skills', async t => {
  const f = fixture(t);
  f.write('project', 'review');
  f.manager.discover();
  await new SkillRuntime(f.manager, f.context).tools()[0].invoke({ name: 'review' });
  f.context.messages = [
    new AIMessage({ content: '', tool_calls: [{ id: 'load-1', name: 'load_skill', args: { name: 'review' } }] }),
    new ToolMessage({ content: 'loaded', tool_call_id: 'load-1' }),
  ];
  const sessions = new SessionManager(path.join(f.root, 'sessions-home'));
  sessions.saveSession(f.context);
  const restored = sessions.loadSession('test')!;
  assert.deepEqual(restored.activeSkills, f.context.activeSkills);
  assert.equal((restored.messages[0] as AIMessage).tool_calls?.[0].id, 'load-1');
  assert.equal((restored.messages[1] as ToolMessage).tool_call_id, 'load-1');
  const store = useAppStore.getState();
  store.initSession(restored);
  assert.deepEqual(store.getSessionContext().activeSkills, restored.activeSkills);
  store.clearMessages();
  assert.deepEqual(store.getSessionContext().activeSkills, []);
  store.initSession({ ...restored, activeSkills: undefined });
  assert.deepEqual(store.getSessionContext().activeSkills, []);
});

class ScriptedModel extends BaseChatModel {
  requests: BaseMessage[][] = [];
  constructor(private replies: AIMessage[]) { super({}); }
  _llmType() { return 'skill-test'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    this.requests.push(messages);
    const message = this.replies.shift();
    assert.ok(message, 'unexpected extra model request');
    return { generations: [{ text: '', message }] };
  }
}

test('real graph executes load/resource/unload and rebuilds the system prompt at each model request', async t => {
  const f = fixture(t);
  const dir = f.write('project', 'review');
  fs.writeFileSync(path.join(dir, 'check.md'), 'RESOURCE_MARKER');
  f.manager.discover();
  const runtime = new SkillRuntime(f.manager, f.context);
  const call = (name: string, args: Record<string, string>, id: string) => new AIMessage({ content: '', tool_calls: [{ name, args, id }] });
  const model = new ScriptedModel([
    call('load_skill', { name: 'review' }, '1'),
    call('read_skill_resource', { name: 'review', path: 'check.md' }, '2'),
    call('unload_skill', { name: 'review' }, '3'),
    new AIMessage('Done'),
  ]);
  const contextManager = new ContextManager();
  t.after(() => contextManager.cleanup());
  const agent = createAgent({ model, tools: runtime.tools(), middleware: [
    createSkillMiddleware(runtime, contextManager, f.context, 'Base prompt', () => {}),
  ] });
  const result = await agent.invoke({ messages: [new HumanMessage('Use review')] });
  assert.equal(result.messages.at(-1)?.content, 'Done');
  assert.equal(model.requests.length, 4);
  const system = (i: number) => String(model.requests[i][0].content);
  assert.ok(!system(0).includes('BODY_ONLY_MARKER'));
  assert.ok(system(1).includes('BODY_ONLY_MARKER'));
  assert.ok(system(2).includes('BODY_ONLY_MARKER'));
  assert.ok(!system(3).includes('BODY_ONLY_MARKER'));
  assert.ok(model.requests[2].some(m => String(m.content).includes('RESOURCE_MARKER')));
  assert.deepEqual(f.context.activeSkills, []);
  assert.ok((f.context.tokenUsage?.totalTokens ?? 0) > 0);
});

test('active instructions survive actual history compression and do not leak into another session', async t => {
  const f = fixture(t);
  f.write('project', 'review');
  f.manager.discover();
  await new SkillRuntime(f.manager, f.context).tools()[0].invoke({ name: 'review' });
  const resumed = JSON.parse(JSON.stringify(f.context));
  const runtime = new SkillRuntime(f.manager, resumed);
  const contextManager = new ContextManager({ maxTokens: 6000, compressionThreshold: 0.5 });
  t.after(() => contextManager.cleanup());
  const model = new ScriptedModel([new AIMessage('Done')]);
  const history = Array.from({ length: 20 }, () => new HumanMessage('long historical context '.repeat(300)));
  history.push(...Array.from({ length: 10 }, () => new HumanMessage('recent')));
  const agent = createAgent({ model, tools: runtime.tools(), middleware: [
    createSkillMiddleware(runtime, contextManager, resumed, 'Base', () => {}),
  ] });
  await agent.invoke({ messages: history });
  assert.equal(resumed.compressionCount, 1);
  assert.match(String(model.requests[0][0].content), /BODY_ONLY_MARKER/);
  assert.ok(model.requests[0].length < history.length);
  const other = { ...f.context, activeSkills: [] };
  assert.ok(!new SkillRuntime(f.manager, other).prompt().includes('BODY_ONLY_MARKER'));
});

test('compression keeps tool call/result pairs and budgets the system instructions', async () => {
  const manager = new ContextManager({ maxTokens: 1000 });
  try {
    const call = new AIMessage({ content: '', tool_calls: [{ name: 'load_skill', id: '1', args: { name: 'review' } }] });
    const result = new ToolMessage({ content: 'body', tool_call_id: '1' });
    const history = [new SystemMessage('active rules'), ...Array.from({ length: 12 }, () => new HumanMessage('old')), call, result, ...Array.from({ length: 9 }, () => new HumanMessage('recent'))];
    const compressed = await manager.compressMessages(history);
    const idx = compressed.messages.indexOf(call);
    assert.ok(idx >= 0);
    assert.equal(compressed.messages[idx + 1], result);
    assert.equal(compressed.messages.filter(m => m._getType() === 'system').length, 1);
    const short = [new SystemMessage('rules'), new HumanMessage('question')];
    assert.deepEqual((await manager.manageContext(short)).messages, short);
    assert.throws(() => manager.assertWithinBudget([new SystemMessage('large rules '.repeat(2000))]), /budget exceeded/);
  } finally { manager.cleanup(); }
});
