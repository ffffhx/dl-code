import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { createAgent } from 'langchain';
import { z } from 'zod';
import { ContextManager } from '../src/context/ContextManager.js';
import { ContextArtifacts } from '../src/context/ContextArtifacts.js';
import { historyHash, validCheckpoint } from '../src/context/history.js';
import { TokenCounter } from '../src/context/TokenCounter.js';
import { SessionManager } from '../src/session/SessionManager.js';
import { useAppStore } from '../src/store/app-store.js';
import { SkillManager } from '../src/skills/SkillManager.js';
import { SkillRuntime } from '../src/skills/SkillRuntime.js';
import { createSkillMiddleware } from '../src/skills/middleware.js';
import type { SessionContext } from '../src/session/types.js';

function temporary(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deer-context-test-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('deer-context-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

const handoff = JSON.stringify({
  Goal: ['Finish the requested feature'],
  Constraints: ['Preserve user changes'],
  Completed: ['Edited src/example.ts'],
  Pending: ['Check the failing validation'],
  Files: ['src/example.ts'],
  Validation: ['npm test failed; success is not established'],
  Next: ['Fix failure and rerun npm test'],
});

class FakeModel extends BaseChatModel {
  requests: BaseMessage[][] = [];
  constructor(private reply: (index: number) => AIMessage = () => new AIMessage(handoff)) { super({}); }
  _llmType() { return 'offline-context-test'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    this.requests.push(messages);
    return { generations: [{ text: '', message: this.reply(this.requests.length - 1) }] };
  }
}

function manager(t: TestContext, model = new FakeModel(), overrides = {}) {
  const value = new ContextManager({
    maxTokens: 6000, reserveOutputTokens: 300, safetyMarginTokens: 100,
    recentTokens: 600, summaryTokens: 600, toolOutputTokens: 400,
    chatModel: model, ...overrides,
  });
  t.after(() => value.cleanup());
  return value;
}

function history() {
  return [
    new HumanMessage('ORIGINAL_GOAL'),
    ...Array.from({ length: 18 }, (_, i) => new AIMessage('OLD_SEGMENT_' + i + ': ' + 'historical state '.repeat(150))),
    new HumanMessage('LATEST_REQUEST: finish the feature without overwriting my changes'),
  ];
}

function session(messages = history()): SessionContext {
  return { sessionId: 'context-test', messages, userName: null, todos: [], createdAt: 1, updatedAt: 1 };
}

test('checkpoint survives disk/store resume, reuses summary, advances only across new history', async t => {
  const root = temporary(t);
  const model = new FakeModel();
  const cm = manager(t, model);
  const artifacts = new ContextArtifacts('context-test', root);
  const raw = history();
  const first = await cm.manageContext([new SystemMessage('SYSTEM_RULE'), ...raw], { artifacts });
  assert.equal(first.compressed, true);
  assert.ok(first.checkpoint);
  assert.ok(first.compressionResult!.tokensSaved > 0);
  for (const field of ['Goal', 'Constraints', 'Completed', 'Pending', 'Files', 'Validation', 'Next']) {
    assert.match(first.checkpoint.summary, new RegExp(field + ':'));
  }
  assert.equal(first.messages.at(-1), raw.at(-1));
  assert.ok(first.usage.totalTokens < cm.inputBudget * 0.8);
  assert.equal(first.usage.outputTokens, 0);
  const count = model.requests.length;
  const contexts = new SessionManager(path.join(root, 'sessions'));
  const state = { ...session(raw), contextCheckpoint: first.checkpoint };
  contexts.saveSession(state);
  const restored = contexts.loadSession(state.sessionId)!;
  const store = useAppStore.getState();
  store.initSession(restored);
  assert.deepEqual(store.getSessionContext().contextCheckpoint, first.checkpoint);
  const next = await cm.manageContext([new SystemMessage('NEW_SYSTEM_RULE'), ...restored.messages, new AIMessage('continuing')],
    { checkpoint: store.getSessionContext().contextCheckpoint, artifacts });
  assert.equal(next.compressed, false);
  assert.equal(model.requests.length, count, 'must not summarize the same prefix again');
  assert.equal(next.messages[0].content, 'NEW_SYSTEM_RULE');
  assert.ok(!next.messages.some(message => String(message.content).includes('OLD_SEGMENT_0:')));
  assert.equal(restored.messages.length, raw.length, 'full original transcript remains persisted');

  const longer = [...restored.messages, ...Array.from({ length: 18 }, () => new AIMessage('NEW_SEGMENT ' + 'new observations '.repeat(140))), new HumanMessage('NEW_REQUEST')];
  const advanced = await cm.manageContext(longer, { checkpoint: first.checkpoint, artifacts });
  assert.ok(advanced.checkpoint!.coveredMessages > first.checkpoint.coveredMessages);
  const newSummaryInputs = model.requests.slice(count).map(messages => messages.map(m => String(m.content)).join('\n')).join('\n');
  assert.ok(newSummaryInputs.includes('Previous handoff:'));
  assert.ok(newSummaryInputs.includes('NEW_SEGMENT'));
  assert.ok(!newSummaryInputs.includes('OLD_SEGMENT_0:'));
  for (const request of model.requests) assert.ok(cm.getTotalTokens(request) <= cm.inputBudget, 'summary requests also fit');

  store.clearMessages();
  assert.equal(store.getSessionContext().contextCheckpoint, undefined);
  store.initSession(session([]));
  assert.equal(store.getSessionContext().contextCheckpoint, undefined, 'legacy and other sessions do not inherit checkpoint');
});

test('editing or truncating the covered prefix invalidates the checkpoint', async t => {
  const cm = manager(t);
  const raw = history();
  const compressed = await cm.manageContext(raw);
  const changed = [...raw];
  changed[0] = new HumanMessage('CHANGED_GOAL');
  assert.equal(validCheckpoint(compressed.checkpoint, changed), false);
  assert.equal(validCheckpoint(compressed.checkpoint, raw.slice(0, 2)), false);
  const short = await cm.manageContext([new HumanMessage('unrelated')], { checkpoint: compressed.checkpoint });
  assert.equal(short.checkpoint, undefined);
  assert.equal(short.messages.length, 1);
  raw[0].id = 'framework-assigned-on-resume';
  assert.ok(validCheckpoint(compressed.checkpoint, raw), 'message IDs do not invalidate stable content');
});

test('tool outputs are archived losslessly with identity preserved and paged retrieval', async t => {
  const root = temporary(t);
  const cm = manager(t);
  const artifacts = new ContextArtifacts('a', root);
  const content = 'HEAD\n' + '日志😀 result '.repeat(1400) + '\nTAIL_ERROR';
  const tool = new ToolMessage({ id: 'msg-result', name: 'bash', tool_call_id: 'call-1', status: 'error', content });
  const raw = [new HumanMessage('inspect'), new AIMessage({ content: '', tool_calls: [{ id: 'call-1', name: 'bash', args: {} }] }), tool];
  const first = await cm.manageContext(raw, { artifacts });
  assert.equal(first.compressed, false);
  const compact = first.messages.at(-1) as ToolMessage;
  assert.equal(compact.tool_call_id, 'call-1');
  assert.equal(compact.status, 'error');
  assert.equal(compact.id, 'msg-result');
  assert.equal(tool.content, content);
  assert.ok(cm.countText(String(compact.content)) <= cm.toolOutputTokens);
  assert.match(String(compact.content), /HEAD/);
  assert.match(String(compact.content), /TAIL_ERROR/);
  const id = String(compact.content).match(/output-[a-f0-9]{64}\.txt/)![0];
  let retrieved = '';
  let offset: number | null = 0;
  while (offset !== null) {
    const page = artifacts.read(id, offset, 3000);
    retrieved += page.content;
    offset = page.nextOffset;
  }
  assert.equal(retrieved, content);
  const repeated = await cm.manageContext(raw, { artifacts });
  assert.equal(repeated.messages.at(-1)!.content, compact.content);
  assert.equal(fs.readdirSync(artifacts.directory).length, 1);
  const read = JSON.parse(await artifacts.tool().invoke({ id, offset: content.length - 10, limit: 10 }));
  assert.equal(read.content, 'TAIL_ERROR');
  assert.match(await artifacts.tool().invoke({ id: '../outside.txt' }), /Invalid context artifact/);
  assert.match(await new ContextArtifacts('b', root).tool().invoke({ id }), /Context artifact error/);
});

test('archive write failure is visible and never substitutes a broken reference', async t => {
  class BrokenArtifacts extends ContextArtifacts {
    override write(): string { throw new Error('disk full'); }
  }
  const cm = manager(t);
  await assert.rejects(cm.manageContext([new HumanMessage('read'), new ToolMessage({ content: 'large '.repeat(2000), tool_call_id: '1' })],
    { artifacts: new BrokenArtifacts('broken', temporary(t)) }), /disk full/);
});

test('token-budget retention preserves latest user and complete parallel tool exchanges', async t => {
  const cm = manager(t, new FakeModel(), { recentTokens: 80 });
  const user = new HumanMessage('EXACT_USER_REQUEST');
  const call = new AIMessage({ content: '', tool_calls: [
    { id: 'a', name: 'one', args: { path: 'src/a.ts' } }, { id: 'b', name: 'two', args: { path: 'src/b.ts' } },
  ] });
  const results = [new ToolMessage({ content: 'a done', tool_call_id: 'a' }), new ToolMessage({ content: 'b done', tool_call_id: 'b' })];
  const raw = [...history().slice(0, -1), user,
    ...Array.from({ length: 12 }, () => new AIMessage('intermediate work '.repeat(180))),
    call, ...results];
  const managed = await cm.manageContext([new SystemMessage('PINNED_RULE'), ...raw]);
  assert.ok(managed.compressed);
  assert.ok(managed.messages.includes(user));
  const index = managed.messages.indexOf(call);
  assert.ok(index >= 0);
  assert.deepEqual(managed.messages.slice(index + 1), results);
  assert.equal(managed.messages[0].content, 'PINNED_RULE');
  assert.ok(managed.checkpoint!.coveredMessages > raw.indexOf(user), 'latest user stays pinned even when its old position is covered');
  assert.equal(managed.messages.filter(m => m === user).length, 1);
});

test('pending tool exchange is retained; large latest requests and schemas fail before model invocation', async t => {
  const model = new FakeModel();
  const cm = manager(t, model, { recentTokens: 20 });
  const call = new AIMessage({ content: '', tool_calls: [{ id: 'pending', name: 'bash', args: {} }] });
  const raw = [...history(), call];
  const managed = await cm.manageContext(raw);
  assert.equal(managed.messages.at(-1), call);
  const before = model.requests.length;
  await assert.rejects(cm.manageContext([new HumanMessage('huge latest request '.repeat(4000))]), /budget exceeded/);
  await assert.rejects(cm.manageContext([new SystemMessage('rules'), new HumanMessage('hello')], { toolTokens: cm.inputBudget }), /budget exceeded/);
  assert.equal(model.requests.length, before);
});

test('invalid or failed model summary yields a bounded labelled fallback with retrievable history', async t => {
  const model = new FakeModel(() => new AIMessage('not valid JSON'));
  const cm = manager(t, model);
  const artifacts = new ContextArtifacts('fallback', temporary(t));
  const managed = await cm.manageContext(history(), { artifacts });
  assert.ok(managed.compressed);
  assert.match(managed.checkpoint!.summary, /Summary unavailable or invalid/);
  assert.ok(cm.countText(managed.checkpoint!.summary) <= 600);
  const original = artifacts.read(managed.checkpoint!.historyArtifact!);
  assert.ok(original.content.includes('ORIGINAL_GOAL'));
  const count = model.requests.length;
  await cm.manageContext(history(), { checkpoint: managed.checkpoint, artifacts });
  assert.equal(model.requests.length, count);
});

test('tool arguments enter summary prompts and token estimates; cancellation never commits a checkpoint', async t => {
  const cm = manager(t);
  const call = new AIMessage({ content: '', tool_calls: [{ id: 'arg', name: 'editor', args: { path: 'EXACT_FILE_PATH', text: 'arg '.repeat(2000) } }] });
  const counter = new TokenCounter('gpt-4');
  t.after(() => counter.free());
  assert.ok(counter.countMessageTokens(call) > 2000);
  const model = new FakeModel();
  const summarizing = manager(t, model);
  await summarizing.manageContext([call, new ToolMessage({ tool_call_id: 'arg', content: 'edited' }), ...history()]);
  assert.ok(model.requests.some(messages => messages.some(m => String(m.content).includes('EXACT_FILE_PATH'))));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(cm.manageContext(history(), { signal: controller.signal }), /abort/i);
});

test('real graph reuses the persisted checkpoint between tool steps and a subsequent turn', async t => {
  const root = temporary(t);
  const context = session();
  const summaryModel = new FakeModel();
  const cm = manager(t, summaryModel);
  const artifacts = new ContextArtifacts(context.sessionId, root);
  const skillManager = new SkillManager(root, path.join(root, 'skills'));
  skillManager.discover();
  const runtime = new SkillRuntime(skillManager, context);
  const tool = new DynamicStructuredTool({
    name: 'large_output', description: 'Return test output', schema: z.object({}),
    func: async () => 'RESULT '.repeat(3000),
  });
  const main = new FakeModel(index => index === 0
    ? new AIMessage({ content: '', tool_calls: [{ name: 'large_output', id: 'result', args: {} }] })
    : new AIMessage('Done'));
  const middleware = createSkillMiddleware(runtime, cm, context, 'SYSTEM_RULE', () => {}, { artifacts });
  const graph = createAgent({ model: main, tools: [tool, artifacts.tool()], middleware: [middleware] });
  const result = await graph.invoke({ messages: context.messages });
  assert.equal(main.requests.length, 2);
  assert.equal(context.compressionCount, 1);
  assert.ok(main.requests[1].some(m => String(m.content).includes('Tool output saved:')));
  assert.ok((result.messages.at(-2) as ToolMessage).content.toString().length > 10000, 'graph retains full transcript');
  assert.ok(validCheckpoint(context.contextCheckpoint, result.messages));
  const count = summaryModel.requests.length;
  context.messages = [...result.messages, new HumanMessage('continue')];
  const resumed = createAgent({
    model: main, tools: [tool, artifacts.tool()],
    middleware: [createSkillMiddleware(runtime, cm, context, 'NEW_RULE', () => {}, { artifacts })],
  });
  await resumed.invoke({ messages: context.messages });
  assert.equal(summaryModel.requests.length, count);
  assert.equal(context.compressionCount, 1);
  assert.ok(String(main.requests.at(-1)![0].content).includes('NEW_RULE'));
});

test('inbox messages remain pinned without changing transcript checkpoint indexes', async t => {
  const cm = manager(t);
  const raw = history();
  const note = new HumanMessage('PARENT_CORRECTION');
  const first = await cm.manageContext(raw, { pinnedMessages: [note] });
  assert.equal(first.messages.at(-1), note);
  assert.ok(validCheckpoint(first.checkpoint, raw));
  assert.equal(first.checkpoint!.prefixHash, historyHash(raw.slice(0, first.checkpoint!.coveredMessages)));
  const next = await cm.manageContext(raw, { checkpoint: first.checkpoint, pinnedMessages: [note] });
  assert.equal(next.compressed, false);
  assert.equal(next.messages.at(-1), note);
});

test('invalid context budgets are rejected', () => {
  for (const config of [
    { maxTokens: 0 }, { maxTokens: NaN }, { reserveOutputTokens: -1 }, { safetyMarginTokens: Infinity },
    { maxTokens: 1000, reserveOutputTokens: 1000 }, { compressionThreshold: 0 },
    { compressionThreshold: 0.5, targetRatio: 0.7 }, { toolOutputTokens: 0 },
  ]) assert.throws(() => new ContextManager(config), /Invalid context/);
});

test('text-only multipart tool results are archived while image content stays intact', async t => {
  const cm = manager(t);
  const artifacts = new ContextArtifacts('multipart', temporary(t));
  const blocks = [{ type: 'text' as const, text: 'MCP_TEXT '.repeat(3000) }];
  const text = new ToolMessage({ content: blocks, tool_call_id: 'text' });
  const image = new ToolMessage({ content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } }], tool_call_id: 'image' });
  const managed = await cm.manageContext([new HumanMessage('Inspect results'), text, image], { artifacts });
  const preview = String(managed.messages.find(m => (m as ToolMessage).tool_call_id === 'text')!.content);
  const id = preview.match(/output-[a-f0-9]{64}\.txt/)![0];
  assert.equal(fs.readFileSync(path.join(artifacts.directory, id), 'utf8'), JSON.stringify(blocks));
  assert.ok(managed.messages.includes(image));
  assert.deepEqual(text.content, blocks);
});

test('persisted transcript includes inbox messages exactly once and keeps checkpoints valid', async t => {
  const root = temporary(t);
  const context = session();
  const cm = manager(t);
  const artifacts = new ContextArtifacts(context.sessionId, root);
  const skillManager = new SkillManager(root, path.join(root, 'skills'));
  skillManager.discover();
  const note = new HumanMessage({ id: 'mail', content: 'INBOX_NOTE' });
  let delivered = false;
  const snapshots: SessionContext[] = [];
  const graph = createAgent({
    model: new FakeModel(index => index === 0
      ? new AIMessage({ content: '', tool_calls: [{ id: 'ping', name: 'ping', args: {} }] })
      : new AIMessage('Done')),
    tools: [new DynamicStructuredTool({ name: 'ping', description: 'ping', schema: z.object({}), func: async () => 'pong' })],
    middleware: [createSkillMiddleware(new SkillRuntime(skillManager, context), cm, context, 'RULES', state => {
      assert.ok(validCheckpoint(state.contextCheckpoint, state.messages));
      snapshots.push({ ...state, messages: [...state.messages] });
    }, {
      artifacts,
      takeMessages: () => {
        if (delivered) return [];
        delivered = true;
        context.messages.push(note); // Same behavior as AgentManager.takeMessages.
        return [note];
      },
    })],
  });
  await graph.invoke({ messages: context.messages });
  assert.equal(context.messages.filter(m => m.id === 'mail').length, 1);
  assert.ok(snapshots.length >= 2);
  assert.equal(context.compressionCount, 1);
  const sessions = new SessionManager(path.join(root, 'saved'));
  sessions.saveSession(context);
  const restored = sessions.loadSession(context.sessionId)!;
  assert.ok(validCheckpoint(restored.contextCheckpoint, restored.messages));
  const resumed = await cm.manageContext(restored.messages, { checkpoint: restored.contextCheckpoint, artifacts });
  assert.equal(resumed.compressed, false);
});

test('overlong structured summaries stay bounded and thrown model errors use the explicit fallback', async t => {
  const large = new FakeModel(() => new AIMessage(JSON.stringify(Object.fromEntries(
    ['Goal', 'Constraints', 'Completed', 'Pending', 'Files', 'Validation', 'Next'].map(key => [key, ['details '.repeat(5000)]]),
  ))));
  const cm = manager(t, large);
  const result = await cm.manageContext(history());
  assert.ok(result.compressed);
  assert.ok(cm.countText(result.checkpoint!.summary) <= 600);
  for (const key of ['Goal', 'Constraints', 'Completed', 'Pending', 'Files', 'Validation', 'Next']) {
    assert.match(result.checkpoint!.summary, new RegExp(key + ':'));
  }
  const failing = manager(t, new FakeModel(() => { throw new Error('provider unavailable'); }));
  const fallback = await failing.manageContext(history());
  assert.match(fallback.checkpoint!.summary, /Summary unavailable or invalid/);
});

test('cancellation during a summary propagates without a misleading fallback', async t => {
  const controller = new AbortController();
  const cm = manager(t, new FakeModel(() => {
    controller.abort();
    throw new Error('request cancelled');
  }));
  await assert.rejects(cm.manageContext(history(), { signal: controller.signal }), /cancelled/);
});

test('modified artifact files are not silently reused as original output', t => {
  const artifacts = new ContextArtifacts('integrity', temporary(t));
  const id = artifacts.write('output', 'original');
  fs.writeFileSync(path.join(artifacts.directory, id), 'modified');
  assert.throws(() => artifacts.write('output', 'original'), /corrupted/);
});
