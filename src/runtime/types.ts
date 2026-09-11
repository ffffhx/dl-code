import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import type { SessionContext, SessionRun } from '../session/types.js';
import type { AgentExecution } from '../agents/coding-agent.js';
import type { SubagentManager } from '../agents/subagents/SubagentManager.js';

export interface AgentEngine {
  execute(context: SessionContext, changed: (context: SessionContext) => void, execution: AgentExecution): AsyncIterable<unknown>;
  cleanup(): Promise<void>;
}

export type AgentSessionPayload =
  | { type: 'run_started'; run: SessionRun }
  | { type: 'session_updated'; context: SessionContext }
  | { type: 'message'; message: BaseMessage }
  | { type: 'text_delta'; messageId: string; text: string }
  | { type: 'tool_requested'; call: NonNullable<AIMessage['tool_calls']>[number] }
  | { type: 'tool_result'; toolCallId: string; content: BaseMessage['content']; status?: string }
  | { type: 'context_compacted'; count: number }
  | { type: 'agent_updated'; agent: ReturnType<SubagentManager['inspect']> }
  | { type: 'run_finished'; run: SessionRun };

export type AgentSessionEvent = AgentSessionPayload & { sessionId: string; runId?: string; sequence: number; timestamp: number };

export interface AgentSessionDependencies {
  context: SessionContext;
  engine: AgentEngine;
  agents: SubagentManager;
  save: (context: SessionContext) => void;
  closeConnections?: () => Promise<void>;
}
