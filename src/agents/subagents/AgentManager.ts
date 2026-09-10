import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { HumanMessage, ToolMessage, type AIMessage } from '@langchain/core/messages';
import type { SessionContext } from '../../session/types.js';
import { AgentJournal } from './AgentJournal.js';
import type { AgentRecord, RunnerFactory } from './types.js';

export class AgentManager {
  private records = new Map<string, AgentRecord>();
  private running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private events = new EventEmitter();
  private closed = false;
  private releaseJournal: () => void;

  constructor(readonly rootId: string, readonly journal: AgentJournal, private factory: RunnerFactory, readonly maxChildren = 2) {
    this.releaseJournal = journal.claim();
    try { for (const record of journal.load(true)) {
      if (record.id !== rootId && record.parentId !== rootId) continue;
      this.records.set(record.id, record);
      if (record.status === 'running' || record.status === 'cancelling') {
        record.status = 'interrupted';
        record.error = 'Process stopped during execution. Send an explicit follow-up to continue; completed tools are not replayed.';
        journal.save(record, 'interrupted');
      }
    } } catch (error) { this.releaseJournal(); throw error; }
  }

  attachRoot(context: SessionContext): void {
    if (context.sessionId !== this.rootId) throw new Error('Root session mismatch');
    const existing = this.records.get(this.rootId);
    this.records.set(this.rootId, { id: this.rootId, task: 'Main conversation', status: 'running', inbox: existing?.inbox ?? [], context });
    this.save(this.rootId, 'root_started');
  }

  update(id: string, context: SessionContext): void {
    this.get(id).context = context;
    this.save(id, 'context');
  }

  finishRoot(): void {
    const root = this.records.get(this.rootId);
    if (root) { root.status = 'idle'; this.save(root.id, 'root_idle'); }
  }

  private get(id: string): AgentRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown agent: ${id}`);
    return record;
  }

  private child(id: string): AgentRecord {
    const record = this.get(id);
    if (record.parentId !== this.rootId) throw new Error('Only direct child agents can be controlled');
    return record;
  }

  private save(id: string, event: string): void {
    this.journal.save(this.get(id), event);
    this.events.emit('change', this.inspect(id));
  }

  inspect(id: string) {
    const r = this.get(id);
    return { id: r.id, parentId: r.parentId, task: r.task, status: r.status, result: r.result, error: r.error, pendingMessages: r.inbox.length };
  }

  list() { return [...this.records.keys()].map(id => this.inspect(id)); }
  recoveredRootContext(): SessionContext | undefined { return this.records.get(this.rootId)?.context; }

  subscribe(listener: (record: ReturnType<AgentManager['inspect']>) => void): () => void {
    this.events.on('change', listener);
    return () => { this.events.off('change', listener); };
  }

  private available(): void {
    if (this.closed) throw new Error('Agent manager is shutting down');
    if (this.running.size >= this.maxChildren) throw new Error(`At most ${this.maxChildren} children may run at once. Wait for a child before starting another.`);
  }

  spawn(task: string, background = '') {
    this.available();
    if (!task.trim()) throw new Error('A concrete task is required');
    const id = `agent-${randomUUID()}`;
    const now = Date.now();
    const context: SessionContext = { sessionId: id, messages: [new HumanMessage(`Task: ${task}\n\nBackground from parent:\n${background}`)], userName: null, todos: [], activeSkills: [], createdAt: now, updatedAt: now };
    this.records.set(id, { id, parentId: this.rootId, task, status: 'idle', context, inbox: [] });
    this.save(id, 'created');
    this.start(id);
    return this.inspect(id);
  }

  private start(id: string): void {
    this.available();
    const record = this.child(id);
    record.status = 'running';
    record.result = undefined;
    record.error = undefined;
    // Interrupted tool requests need explicit results before another model request.
    const completed = new Set(record.context.messages.filter(m => m._getType() === 'tool').map(m => (m as ToolMessage).tool_call_id));
    const repaired = record.context.messages.flatMap(message => {
      const missing = message._getType() === 'ai' ? ((message as AIMessage).tool_calls ?? []).filter(call => call.id && !completed.has(call.id)) : [];
      return [message, ...missing.map(call => new ToolMessage({ tool_call_id: call.id!, content: 'Execution was interrupted; result is unknown. Do not assume success or replay automatically.' }))];
    });
    record.context.messages = repaired;
    const controller = new AbortController();
    // Isolate implicit LangGraph configuration from the parent tool invocation.
    const done = Promise.resolve().then(() => AsyncLocalStorageProviderSingleton.runWithConfig({}, async () => {
      let runner: ReturnType<RunnerFactory> | undefined;
      try {
        controller.signal.throwIfAborted();
        runner = this.factory(record);
        do {
          controller.signal.throwIfAborted();
          record.result = await runner.run(record.context, {
            signal: controller.signal,
            takeMessages: () => this.takeMessages(id),
            onContextChange: context => this.update(id, context),
          });
        } while (record.inbox.length && !controller.signal.aborted);
        controller.signal.throwIfAborted();
        record.status = 'completed';
      } catch (error) {
        record.status = controller.signal.aborted ? 'cancelled' : 'failed';
        record.error = error instanceof Error ? error.message : String(error);
      } finally {
        try { await runner?.cleanup(); } catch (error) {
          record.status = 'failed'; record.error = `Cleanup failed: ${String(error)}`;
        }
        this.running.delete(id);
        this.save(id, record.status);
        const parent = this.records.get(this.rootId);
        if (parent) {
          parent.inbox.push({ id: randomUUID(), from: id, text: JSON.stringify(this.inspect(id)), createdAt: Date.now() });
          this.save(parent.id, 'child_result_received');
        }
      }
    }));
    this.running.set(id, { controller, done });
    this.save(id, 'started');
    // Preserve an observable error if journal writes fail instead of an unhandled rejection.
    void done.catch(error => { record.status = 'failed'; record.error = String(error); this.events.emit('change', this.inspect(id)); });
  }

  sendMessage(id: string, text: string) {
    if (this.closed) throw new Error('Agent manager is shutting down');
    const record = this.child(id);
    if (!text.trim()) throw new Error('Message must not be empty');
    if (record.status === 'cancelling') throw new Error('Wait for cancellation to settle before sending a follow-up');
    const active = this.running.has(id);
    if (!active) this.available();
    record.inbox.push({ id: randomUUID(), from: this.rootId, text, createdAt: Date.now() });
    this.save(id, 'message_received');
    if (!active) this.start(id);
    return { ...this.inspect(id), delivery: 'queued; consumed before the next model request' };
  }

  takeMessages(id: string): HumanMessage[] {
    const record = this.get(id);
    const incoming = record.inbox.splice(0);
    const messages = incoming.map(mail => new HumanMessage({ id: mail.id, content: `[Agent message from ${mail.from}]\n${mail.text}` }));
    record.context.messages.push(...messages);
    if (incoming.length) this.save(id, 'messages_delivered');
    return messages;
  }

  async wait(id: string, timeoutMs = 30000, signal?: AbortSignal) {
    this.child(id);
    signal?.throwIfAborted();
    const running = this.running.get(id);
    if (running) {
      await new Promise<void>((resolve, reject) => {
        const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); };
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new Error('Aborted')); };
        const timer = setTimeout(finish, Math.max(0, Math.min(timeoutMs, 60000)));
        signal?.addEventListener('abort', abort, { once: true });
        void running.done.then(finish, finish);
        if (signal?.aborted) abort();
      });
    }
    return this.inspect(id);
  }

  async cancel(id: string) {
    const record = this.child(id);
    const running = this.running.get(id);
    if (running) {
      record.status = 'cancelling';
      this.save(id, 'cancel_requested');
      running.controller.abort(new Error('Cancelled by parent'));
      return this.wait(id, 5000);
    }
    return this.inspect(id);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const { controller } of this.running.values()) controller.abort(new Error('Application shutting down'));
    try {
      await Promise.allSettled([...this.running.values()].map(run => run.done));
      this.finishRoot();
    } finally { this.releaseJournal(); }
  }
}
