import { randomUUID } from 'node:crypto';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { serializeMessages, deserializeMessages } from '../session/SessionManager.js';
import type { SessionContext, SessionRun } from '../session/types.js';
import { createSubagentTools } from '../agents/subagents/tools.js';
import type { AgentSessionDependencies, AgentSessionEvent, AgentSessionPayload } from './types.js';

function copy(context: SessionContext): SessionContext {
  const data = JSON.parse(JSON.stringify({ ...context, messages: serializeMessages(context.messages) }));
  return { ...data, messages: deserializeMessages(data.messages) };
}

/** Owns one session. LangChain remains the execution engine; consumers only see events. */
export class AgentSession {
  private context: SessionContext;
  private active?: { id: string; controller: AbortController; done: Promise<void> };
  private listeners = new Set<(event: AgentSessionEvent) => void>();
  private sequence = 0;
  private closing?: Promise<void>;
  private closed = false;
  private unsubscribe: () => void;

  constructor(private deps: AgentSessionDependencies) {
    this.context = copy(deps.agents.recoveredRootContext() ?? deps.context);
    if (this.context.lastRun?.status === 'running') {
      this.context.lastRun = { ...this.context.lastRun, status: 'interrupted', error: 'Execution stopped before completion; inspect unknown tool outcomes before continuing.' };
    }
    deps.agents.attachRoot(this.context);
    deps.agents.finishRoot();
    deps.save(this.context);
    this.unsubscribe = deps.agents.subscribe(agent => {
      if (agent.parentId) this.emit({ type: 'agent_updated', agent });
    });
  }

  snapshot(): SessionContext { return copy(this.context); }
  get activeRunId(): string | undefined { return this.active?.id; }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(payload: AgentSessionPayload): void {
    const event = { ...payload, sessionId: this.context.sessionId, runId: this.active?.id, sequence: ++this.sequence, timestamp: Date.now() };
    // A broken view must not turn a completed side effect into an execution failure.
    for (const listener of this.listeners) { try { listener(event); } catch { /* subscriber owns its errors */ } }
  }

  private persist(): void {
    this.context.updatedAt = Date.now();
    // Journal is authoritative. The session JSON is a compatibility snapshot.
    this.deps.agents.update(this.context.sessionId, this.context);
    this.deps.save(this.context);
    this.emit({ type: 'session_updated', context: this.snapshot() });
  }

  run(input: { text: string }): AsyncGenerator<AgentSessionEvent> {
    return this.stream(input.text);
  }

  resume(runId: string): AsyncGenerator<AgentSessionEvent> {
    return this.stream(undefined, runId);
  }

  private async *stream(text?: string, resumedFrom?: string): AsyncGenerator<AgentSessionEvent> {
    if (this.closed) throw new Error('AgentSession is closed');
    if (this.active) throw new Error('A run is already active in this session');
    if (resumedFrom) {
      if (this.context.lastRun?.id !== resumedFrom || this.context.lastRun.status === 'completed') throw new Error('Only the latest incomplete run can be resumed');
    } else if (!text?.trim()) throw new Error('A non-empty user request is required');
    const id = `run-${randomUUID()}`;
    const controller = new AbortController();
    const queue: AgentSessionEvent[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    const unsubscribe = this.subscribe(event => {
      if (event.runId === id) { queue.push(event); wake?.(); }
    });
    const done = Promise.resolve().then(() => this.produce(id, controller, text, resumedFrom))
      .finally(() => {
        ended = true;
        if (this.active?.id === id) this.active = undefined;
        wake?.();
      });
    void done.catch(() => {}); // The iterator propagates errors even if its consumer is temporarily idle.
    this.active = { id, controller, done };
    try {
      while (!ended || queue.length) {
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
      await done;
    } finally {
      unsubscribe();
      if (!ended) controller.abort(new Error('Event consumer stopped'));
      await done;
      if (this.active?.id === id) this.active = undefined;
    }
  }

  private async produce(id: string, controller: AbortController, text?: string, resumedFrom?: string): Promise<void> {
    const run: SessionRun = { id, status: 'running', startedAt: Date.now(), resumedFrom };
    this.context.lastRun = run;
    try {
      this.repairPendingCalls();
      if (text !== undefined) this.context.messages.push(new HumanMessage({ id: randomUUID(), content: text }));
      this.deps.agents.attachRoot(this.context);
      this.persist();
      this.emit({ type: 'run_started', run: { ...run } });
      let compressionCount = this.context.compressionCount ?? 0;
      const changed = (context: SessionContext) => {
        this.context = context;
        this.persist();
        if ((context.compressionCount ?? 0) > compressionCount) {
          compressionCount = context.compressionCount!;
          this.emit({ type: 'context_compacted', count: compressionCount });
        }
      };
      for await (const chunk of this.deps.engine.execute(this.context, changed, {
        signal: controller.signal,
        onTextDelta: (messageId, text) => this.emit({ type: 'text_delta', messageId, text }),
        takeMessages: () => this.deps.agents.takeMessages(this.context.sessionId),
        tools: createSubagentTools(this.deps.agents, controller.signal),
      })) {
        controller.signal.throwIfAborted();
        this.forward(chunk);
      }
      controller.signal.throwIfAborted();
      run.status = 'completed';
    } catch (error) {
      run.status = controller.signal.aborted ? 'cancelled' : 'failed';
      run.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (controller.signal.aborted) await this.deps.agents.cancelAll();
      run.finishedAt = Date.now();
      this.context.lastRun = run;
      try { this.persist(); this.deps.agents.finishRoot(); }
      catch (error) {
        run.status = 'failed';
        run.error = 'Persistence failed: ' + String(error);
        // Snapshot failure must not leave the authoritative journal reporting success.
        try { this.deps.agents.update(this.context.sessionId, this.context); this.deps.agents.finishRoot(); }
        catch { /* Storage may be unavailable; report the failure through the live event. */ }
        this.emit({ type: 'session_updated', context: this.snapshot() });
      }
      this.emit({ type: 'run_finished', run: { ...run } });
    }
  }

  private forward(chunk: unknown): void {
    if (!chunk || typeof chunk !== 'object') return;
    for (const node of Object.values(chunk)) {
      if (!node || typeof node !== 'object' || !('messages' in node) || !Array.isArray(node.messages)) continue;
      for (const message of node.messages as BaseMessage[]) {
        if (message._getType() === 'ai') {
          const detached = deserializeMessages(JSON.parse(JSON.stringify(serializeMessages([message]))))[0] as AIMessage;
          this.emit({ type: 'message', message: detached });
          for (const call of detached.tool_calls ?? []) this.emit({ type: 'tool_requested', call });
        } else if (message._getType() === 'tool') {
          const tool = message as ToolMessage;
          this.emit({ type: 'tool_result', toolCallId: tool.tool_call_id, content: JSON.parse(JSON.stringify(tool.content)), status: tool.status });
        }
      }
    }
  }

  private repairPendingCalls(): void {
    const results = new Set(this.context.messages.filter(m => m._getType() === 'tool').map(m => (m as ToolMessage).tool_call_id));
    this.context.messages = this.context.messages.flatMap(message => [message,
      ...(message._getType() === 'ai' ? (message as AIMessage).tool_calls ?? [] : [])
        .filter(call => call.id && !results.has(call.id))
        .map(call => new ToolMessage({ tool_call_id: call.id!, status: 'error', content: 'Execution interrupted; outcome unknown. Inspect the current state before retrying. Do not assume success or replay automatically.' })),
    ]);
  }

  async cancel(runId: string): Promise<void> {
    if (!this.active || this.active.id !== runId) throw new Error('Run is not active');
    const active = this.active;
    active.controller.abort(new Error('Run cancelled'));
    await this.deps.agents.cancelAll();
    await active.done;
  }

  clear(): void {
    if (this.closed || this.active) throw new Error('Cannot clear an active or closed agent session');
    const context: SessionContext = { sessionId: this.context.sessionId, userName: this.context.userName,
      createdAt: this.context.createdAt, updatedAt: Date.now(), messages: [], todos: [], activeSkills: [], compressionCount: 0 };
    this.deps.agents.resetRoot(context);
    this.context = context;
    this.persist();
  }

  shutdown(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      if (this.active) await this.cancel(this.active.id);
      const results = await Promise.allSettled([this.deps.agents.shutdown(), this.deps.engine.cleanup(), this.deps.closeConnections?.()]);
      this.unsubscribe();
      this.listeners.clear();
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'AgentSession cleanup failed');
    })();
    return this.closing;
  }
}
