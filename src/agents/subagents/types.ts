import type { BaseMessage } from '@langchain/core/messages';
import type { SessionContext } from '../../session/types.js';

export type AgentStatus = 'idle' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface AgentMail { id: string; from: string; text: string; createdAt: number }
export interface AgentRecord {
  id: string;
  parentId?: string;
  task: string;
  status: AgentStatus;
  context: SessionContext;
  inbox: AgentMail[];
  result?: string;
  error?: string;
  dependsOn?: string[];
  acceptanceCriteria?: string;
  review?: { status: 'accepted' | 'rejected'; evidence: string; at: number };
}
export interface RunControl {
  signal: AbortSignal;
  takeMessages: () => BaseMessage[];
  onContextChange: (context: SessionContext) => void;
}
export interface AgentRunner {
  run(context: SessionContext, control: RunControl): Promise<string>;
  cleanup(): void | Promise<void>;
}
export type RunnerFactory = (record: AgentRecord) => AgentRunner;
