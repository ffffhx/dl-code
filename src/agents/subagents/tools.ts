import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { SubagentManager } from './SubagentManager.js';

export function createSubagentTools(manager: SubagentManager, signal?: AbortSignal) {
  const safely = async (fn: () => unknown | Promise<unknown>) => {
    try { signal?.throwIfAborted(); return JSON.stringify(await fn()); }
    catch (error) { return `Subagent error: ${error instanceof Error ? error.message : String(error)}`; }
  };
  return [
    new DynamicStructuredTool({ name: 'spawn_agent', description: 'Start an independent read-only child task in the background. Returns its ID immediately. At most two children run concurrently; children cannot spawn children. Provide necessary background explicitly.',
      schema: z.object({ task: z.string().min(1).max(16000), background: z.string().max(32000).optional(),
        depends_on: z.array(z.string()).max(32).optional().describe('Existing child IDs; all must have completed and passed review_agent. Their accepted results become explicit inputs.'),
        acceptance_criteria: z.string().min(1).max(4000).optional().describe('Expected evidence, source paths, output and validation requirements') }),
      func: async ({ task, background, depends_on, acceptance_criteria }) => safely(() => manager.spawn(task, background, { dependsOn: depends_on, acceptanceCriteria: acceptance_criteria })),
    }),
    new DynamicStructuredTool({ name: 'review_agent', description: 'Record the parent review of a completed child. Check its evidence against acceptance criteria before accepting. Completion alone is not acceptance; dependent tasks require acceptance.',
      schema: z.object({ id: z.string(), accepted: z.boolean(), evidence: z.string().min(1).max(4000) }),
      func: async ({ id, accepted, evidence }) => safely(() => manager.review(id, accepted, evidence)) }),
    new DynamicStructuredTool({ name: 'wait_agent', description: 'Wait up to timeout_ms for a child. Returns status and final result, or running on timeout. A timeout does not cancel the child.',
      schema: z.object({ id: z.string(), timeout_ms: z.number().int().min(0).max(60000).default(30000) }),
      func: async ({ id, timeout_ms }) => safely(() => manager.wait(id, timeout_ms, signal)),
    }),
    new DynamicStructuredTool({ name: 'send_message', description: 'Queue additional instructions for a direct child. Delivered before its next model request. An explicit follow-up restarts a completed, failed, cancelled or interrupted child using its own history.',
      schema: z.object({ id: z.string(), message: z.string().min(1).max(32000) }),
      func: async ({ id, message }) => safely(() => manager.sendMessage(id, message)),
    }),
    new DynamicStructuredTool({ name: 'cancel_agent', description: 'Abort a child task. A cancelling child still occupies its concurrency slot until its runner has stopped.',
      schema: z.object({ id: z.string() }), func: async ({ id }) => safely(() => manager.cancel(id)),
    }),
    new DynamicStructuredTool({ name: 'list_agents', description: 'List child IDs, task states and results, including recovered interrupted tasks.',
      schema: z.object({}), func: async () => safely(() => manager.list()),
    }),
  ];
}
