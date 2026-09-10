import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HarnessRuntime } from '../src/harness/HarnessRuntime.js';
import type { AgentEngine, HarnessEvent } from '../src/harness/types.js';
import { AgentManager } from '../src/agents/subagents/AgentManager.js';
import { AgentJournal } from '../src/agents/subagents/AgentJournal.js';
import { SessionManager } from '../src/session/SessionManager.js';
import type { SessionContext } from '../src/session/types.js';
import type { AgentExecution } from '../src/agents/coding-agent.js';
import { CodingAgent } from '../src/agents/coding-agent.js';
import { useAppStore } from '../src/store/app-store.js';

function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deer-harness-test-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('deer-harness-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sessions = new SessionManager(root);
  const context = sessions.createSession();
  const journal = () => new AgentJournal(path.join(root, 'journal'));
  const agents = () => new AgentManager(context.sessionId, journal(), () => ({
    run: async () => 'child result', cleanup: async () => {},
  }));
  return { root, sessions, context, agents };
}

class FakeEngine implements AgentEngine {
  cleaned = 0;
  constructor(readonly work: (context: SessionContext, changed: (context: SessionContext) => void, options: AgentExecution) => AsyncIterable<unknown>
    = async function* (context, changed) {
      const message = new AIMessage({ id: 'reply', content: 'Done' });
      context.messages.push(message);
      changed(context);
      yield { model_request: { messages: [message] } };
    }) {}
  execute(context: SessionContext, changed: (context: SessionContext) => void, options: AgentExecution) {
    return this.work(context, changed, options);
  }
  async cleanup() { this.cleaned++; }
}

async function collect(events: AsyncIterable<HarnessEvent>) {
  const result: HarnessEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function abortable(signal: AbortSignal) {
  return new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    if (signal.aborted) reject(signal.reason);
  });
}

test('headless run owns input, persists results, emits detached snapshots and releases resources once', async t => {
  const f = setup(t);
  const engine = new FakeEngine();
  let closed = 0;
  const runtime = new HarnessRuntime({ context: f.context, engine, agents: f.agents(),
    save: context => f.sessions.saveSession(context, true), closeConnections: async () => { closed++; } });
  t.after(() => runtime.shutdown());
  const events = await collect(runtime.run({ text: 'Implement feature' }));
  const finish = events.find(e => e.type === 'run_finished')!;
  assert.equal(finish.type === 'run_finished' && finish.run.status, 'completed');
  assert.ok(events.every((event, i) => i === 0 || event.sequence > events[i - 1].sequence));
  assert.equal(new Set(events.map(e => e.runId)).size, 1);
  assert.equal(runtime.activeRunId, undefined);
  const saved = f.sessions.loadSession(f.context.sessionId)!;
  assert.equal(saved.messages.filter(m => m._getType() === 'human').length, 1);
  assert.equal(saved.messages.at(-1)!.content, 'Done');
  assert.equal(saved.lastRun!.status, 'completed');
  const snapshot = runtime.snapshot();
  snapshot.messages[0].content = 'tampered';
  assert.equal(runtime.snapshot().messages[0].content, 'Implement feature');
  useAppStore.getState().syncHarnessSession(runtime.snapshot());
  assert.equal(useAppStore.getState().session.displayMessages.length, 2);
  assert.equal(useAppStore.getState().getSessionContext().lastRun!.id, saved.lastRun!.id);
  await runtime.shutdown();
  await runtime.shutdown();
  assert.equal(engine.cleaned, 1);
  assert.equal(closed, 1);
});

test('concurrent runs are rejected; cancellation does not depend on consuming more events', async t => {
  const f = setup(t);
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const engine = new FakeEngine(async function* (_context, _changed, options) {
    started();
    await abortable(options.signal!);
    yield {};
  });
  const runtime = new HarnessRuntime({ context: f.context, engine, agents: f.agents(), save: c => f.sessions.saveSession(c, true) });
  t.after(() => runtime.shutdown());
  const iterator = runtime.run({ text: 'Wait' });
  await iterator.next();
  await entered;
  await assert.rejects(collect(runtime.run({ text: 'duplicate' })), /already active/);
  assert.throws(() => runtime.clear(), /active/);
  await runtime.cancel(runtime.activeRunId!);
  assert.equal(runtime.activeRunId, undefined);
  const rest = await collect(iterator);
  assert.ok(rest.some(e => e.type === 'run_finished' && e.run.status === 'cancelled'));
  assert.equal(runtime.snapshot().lastRun!.status, 'cancelled');
});

test('abandoning an event iterator cancels the producer and permits another run', async t => {
  const f = setup(t);
  let aborted = false;
  const runtime = new HarnessRuntime({ context: f.context, agents: f.agents(), save: c => f.sessions.saveSession(c, true),
    engine: new FakeEngine(async function* (_context, _changed, options) {
      try { await abortable(options.signal!); } finally { aborted = true; }
      yield {};
    }) });
  t.after(() => runtime.shutdown());
  const iterator = runtime.run({ text: 'Wait' });
  await iterator.next();
  await iterator.return(undefined);
  assert.ok(aborted);
  assert.equal(runtime.activeRunId, undefined);
  assert.equal(runtime.snapshot().lastRun!.status, 'cancelled');
});

test('failed runs retain partial history; explicit resume marks unknown tools without replaying them', async t => {
  const f = setup(t);
  let turns = 0;
  const runtime = new HarnessRuntime({ context: f.context, agents: f.agents(), save: c => f.sessions.saveSession(c, true),
    engine: new FakeEngine(async function* (context, changed) {
      if (++turns === 1) {
        context.messages.push(new AIMessage({ content: '', tool_calls: [{ id: 'write-1', name: 'edit', args: {} }] }));
        changed(context);
        throw new Error('provider disconnected');
      }
      const unknown = context.messages.find(m => m._getType() === 'tool') as ToolMessage;
      assert.equal(unknown.tool_call_id, 'write-1');
      assert.match(String(unknown.content), /outcome unknown/);
      const reply = new AIMessage('Recovered');
      context.messages.push(reply);
      changed(context);
      yield { model_request: { messages: [reply] } };
    }) });
  t.after(() => runtime.shutdown());
  await collect(runtime.run({ text: 'Edit' }));
  const first = runtime.snapshot().lastRun!;
  assert.equal(first.status, 'failed');
  await collect(runtime.resume(first.id));
  const restored = runtime.snapshot();
  assert.equal(restored.lastRun!.resumedFrom, first.id);
  assert.notEqual(restored.lastRun!.id, first.id);
  assert.equal(restored.messages.filter(m => m._getType() === 'human').length, 1);
  assert.equal(restored.messages.filter(m => m._getType() === 'tool').length, 1);
  await assert.rejects(collect(runtime.resume(restored.lastRun!.id)), /incomplete/);
});

test('journal recovery restores the authoritative context and interrupts unfinished runs', async t => {
  const f = setup(t);
  const first = f.agents();
  const context = { ...f.context, messages: [new HumanMessage('journal-only')],
    lastRun: { id: 'run-crash', status: 'running' as const, startedAt: 1 } };
  first.attachRoot(context);
  await first.shutdown();
  const runtime = new HarnessRuntime({ context: f.context, engine: new FakeEngine(), agents: f.agents(), save: c => f.sessions.saveSession(c, true) });
  t.after(() => runtime.shutdown());
  assert.equal(runtime.snapshot().messages[0].content, 'journal-only');
  assert.equal(runtime.snapshot().lastRun!.status, 'interrupted');
  await collect(runtime.resume('run-crash'));
  assert.equal(runtime.snapshot().lastRun!.status, 'completed');
});

test('clear persists across restart and discards compressed context and stale inbox', async t => {
  const f = setup(t);
  const runtime = new HarnessRuntime({ context: f.context, engine: new FakeEngine(), agents: f.agents(), save: c => f.sessions.saveSession(c, true) });
  await collect(runtime.run({ text: 'First' }));
  runtime.clear();
  await runtime.shutdown();
  const restored = new HarnessRuntime({ context: f.sessions.getCurrentSession(), engine: new FakeEngine(), agents: f.agents(), save: c => f.sessions.saveSession(c, true) });
  t.after(() => restored.shutdown());
  assert.equal(restored.snapshot().messages.length, 0);
  assert.equal(restored.snapshot().lastRun, undefined);
  assert.equal(restored.snapshot().contextCheckpoint, undefined);
});

test('save failure produces a failed run and never reports completion', async t => {
  const f = setup(t);
  let fail = false;
  const runtime = new HarnessRuntime({ context: f.context, engine: new FakeEngine(), agents: f.agents(),
    save: c => { if (fail) throw new Error('disk full'); f.sessions.saveSession(c, true); } });
  t.after(() => runtime.shutdown());
  fail = true;
  const events = await collect(runtime.run({ text: 'Persist me' }));
  assert.ok(events.some(e => e.type === 'run_finished' && e.run.status === 'failed' && e.run.error?.includes('disk full')));
});

test('subscriber errors do not abort execution', async t => {
  const f = setup(t);
  const runtime = new HarnessRuntime({ context: f.context, engine: new FakeEngine(), agents: f.agents(), save: c => f.sessions.saveSession(c, true) });
  t.after(() => runtime.shutdown());
  runtime.subscribe(() => { throw new Error('view failed'); });
  await collect(runtime.run({ text: 'Run' }));
  assert.equal(runtime.snapshot().lastRun!.status, 'completed');
});

test('final snapshot failure is recorded as failed in the recovery journal', async t => {
  const f = setup(t);
  const runtime = new HarnessRuntime({ context: f.context, engine: new FakeEngine(), agents: f.agents(),
    save: c => {
      if (c.lastRun?.status === 'completed') throw new Error('snapshot unavailable');
      f.sessions.saveSession(c, true);
    } });
  await collect(runtime.run({ text: 'Finish' }));
  await runtime.shutdown();
  const recovered = new HarnessRuntime({ context: f.context, engine: new FakeEngine(), agents: f.agents(),
    save: c => f.sessions.saveSession(c, true) });
  t.after(() => recovered.shutdown());
  assert.equal(recovered.snapshot().lastRun!.status, 'failed');
  assert.match(recovered.snapshot().lastRun!.error!, /snapshot unavailable/);
});

test('shutdown cancels an active producer and closes resources without draining the iterator', async t => {
  const f = setup(t);
  const engine = new FakeEngine(async function* (_context, _changed, options) {
    await abortable(options.signal!);
    yield {};
  });
  const runtime = new HarnessRuntime({ context: f.context, engine, agents: f.agents(), save: c => f.sessions.saveSession(c, true) });
  const iterator = runtime.run({ text: 'Wait' });
  await iterator.next();
  await runtime.shutdown();
  assert.equal(runtime.snapshot().lastRun!.status, 'cancelled');
  assert.equal(engine.cleaned, 1);
  await collect(iterator);
  await assert.rejects(collect(runtime.run({ text: 'Later' })), /closed/);
});

test('real CodingAgent updates Todo without UI and forwards tool/model events', async t => {
  const f = setup(t);
  class Model extends BaseChatModel {
    count = 0;
    _llmType() { return 'harness-test'; }
    bindTools() { return this; }
    async _generate(_messages: BaseMessage[]) {
      const message = this.count++ === 0
        ? new AIMessage({ content: '', tool_calls: [{ id: 'todo-1', name: 'todo_write', args: {
          todos: [{ id: 'one', content: 'Implement feature', status: 'in_progress', priority: 'high' }],
        } }] }) : new AIMessage('Work recorded');
      return { generations: [{ text: '', message }] };
    }
  }
  const runtime = new HarnessRuntime({ context: f.context, engine: new CodingAgent([], { model: new Model({}) }),
    agents: f.agents(), save: c => f.sessions.saveSession(c, true) });
  t.after(() => runtime.shutdown());
  const events = await collect(runtime.run({ text: 'Plan task' }));
  assert.equal(runtime.snapshot().todos[0].content, 'Implement feature');
  assert.equal(f.sessions.loadSession(f.context.sessionId)!.todos.length, 1);
  assert.equal(events.filter(e => e.type === 'tool_requested').length, 1);
  assert.equal(events.filter(e => e.type === 'tool_result').length, 1);
  assert.equal(runtime.snapshot().messages.filter(m => m._getType() === 'ai').length, 2);
  assert.equal(runtime.snapshot().lastRun!.status, 'completed');
});
