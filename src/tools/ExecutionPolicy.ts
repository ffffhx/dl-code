import { createMiddleware } from 'langchain';
import { ToolMessage } from '@langchain/core/messages';
import { randomUUID } from 'node:crypto';

export interface ToolExecutionRecord {
  runId: string; callId: string; name: string; startedAt: number; finishedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'unknown'; error?: string;
}
export interface ExecutionLimits { maxModelCalls?: number; maxToolCalls?: number; toolTimeoutMs?: number }

/** Per-run budgets and audit. Deadlines abort the run; side effects are never retried automatically. */
export function createExecutionPolicy(controller: AbortController, limits: ExecutionLimits = {}, onRecord: (record: ToolExecutionRecord) => void = () => {}) {
  const maxModels = limits.maxModelCalls ?? 50;
  const maxTools = limits.maxToolCalls ?? 150;
  const timeout = limits.toolTimeoutMs ?? 65000;
  for (const value of [maxModels, maxTools, timeout]) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Execution limits must be positive integers');
  let models = 0;
  let calls = 0;
  const seen = new Set<string>();
  const runId = randomUUID();
  return createMiddleware({ name: 'ToolExecutionPolicy',
    wrapModelCall: (request, handler) => {
      controller.signal.throwIfAborted();
      if (++models > maxModels) throw new Error('Model request budget exceeded');
      return handler(request);
    },
    wrapToolCall: async (request, handler) => {
      controller.signal.throwIfAborted();
      if (++calls > maxTools) { controller.abort(new Error('Tool call budget exceeded')); throw controller.signal.reason; }
      const id = request.toolCall.id!;
      if (seen.has(id)) throw new Error('Repeated tool call ID; inspect execution outcome before retrying');
      seen.add(id);
      const record: ToolExecutionRecord = { runId, callId: id, name: request.toolCall.name, startedAt: Date.now(), status: 'running' };
      onRecord({ ...record });
      const timer = setTimeout(() => controller.abort(new Error(`Tool deadline exceeded: ${record.name}; outcome unknown, inspect state before retrying`)), timeout);
      try {
        // Wait for signal-aware tools to settle; no promise-race that releases a still-running writer.
        const result = await handler(request);
        controller.signal.throwIfAborted();
        if (result instanceof ToolMessage && typeof result.content === 'string') {
          const prefixes: Record<string, RegExp> = {
            text_editor: /^Error:/, grep: /^Error:/, ls: /^Error:/, tree: /^Error:/,
            bash: /^Shell (?:error|busy):/,
            search_memory: /^Memory error:/, read_memory: /^Memory error:/, save_memory: /^Memory error:/, invalidate_memory: /^Memory error:/,
            load_skill: /^Skill error:/, read_skill_resource: /^Skill error:/, unload_skill: /^Skill error:/,
            spawn_agent: /^Subagent error:/, wait_agent: /^Subagent error:/, send_message: /^Subagent error:/,
            cancel_agent: /^Subagent error:/, list_agents: /^Subagent error:/, review_agent: /^Subagent error:/,
            search_tools: /^Tool discovery error:/, load_tools: /^Tool discovery error:/,
            read_context_artifact: /^Context artifact error:/,
          };
          const knownError = prefixes[record.name]?.test(result.content) ?? false;
          const exit = record.name === 'bash' ? /\[exit_code: (-?\d+)\]\s*$/.exec(result.content) : null;
          if (knownError || (exit && Number(exit[1]) !== 0)) result.status = 'error';
        }
        record.status = result instanceof ToolMessage && result.status === 'error' ? 'failed' : 'completed';
        return result;
      } catch (error) {
        record.status = controller.signal.aborted ? 'unknown' : 'failed';
        record.error = String(error);
        if (controller.signal.aborted) throw error;
        return new ToolMessage({ tool_call_id: id, status: 'error', content: `Tool execution failed: ${String(error)}. Do not assume success. Check state before retrying a write.` });
      } finally {
        clearTimeout(timer);
        record.finishedAt = Date.now();
        onRecord({ ...record });
      }
    },
  });
}
