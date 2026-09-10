import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import type { SessionContext, SessionRun } from '../session/types.js';
import type { AgentExecution } from '../agents/coding-agent.js';
import type { AgentManager } from '../agents/subagents/AgentManager.js';

export interface AgentEngine {
  execute(context: SessionContext, changed: (context: SessionContext) => void, execution: AgentExecution): AsyncIterable<unknown>;
  cleanup(): Promise<void>;
}

export type HarnessPayload =
  | { type: 'run_started'; run: SessionRun }
  | { type: 'session_updated'; context: SessionContext }
  | { type: 'message'; message: BaseMessage }
  | { type: 'tool_requested'; call: NonNullable<AIMessage['tool_calls']>[number] }
  | { type: 'tool_result'; toolCallId: string; content: BaseMessage['content']; status?: string }
  | { type: 'context_compacted'; count: number }
  | { type: 'agent_updated'; agent: ReturnType<AgentManager['inspect']> }
  | { type: 'run_finished'; run: SessionRun };

export type HarnessEvent = HarnessPayload & { sessionId: string; runId?: string; sequence: number; timestamp: number };

export interface HarnessDependencies {
  context: SessionContext;
  engine: AgentEngine;
  agents: AgentManager;
  save: (context: SessionContext) => void;
  closeConnections?: () => Promise<void>;
}
