import { createHash } from 'node:crypto';
import type { AIMessage, BaseMessage, ToolMessage } from '@langchain/core/messages';

/** Indexes refer to the original non-system transcript, never to the model view. */
export interface ContextCheckpoint {
  version: 1;
  summary: string;
  coveredMessages: number;
  prefixHash: string;
  historyArtifact?: string;
}

export function messageRecord(message: BaseMessage) {
  return {
    role: message._getType(),
    content: message.content,
    tool_calls: (message as AIMessage).tool_calls,
    tool_call_id: (message as ToolMessage).tool_call_id,
    additional_kwargs: message.additional_kwargs,
  };
}

// Ignore framework-assigned message IDs and usage metadata: these can change on resume.
export function historyHash(messages: BaseMessage[]): string {
  const hash = createHash('sha256');
  for (const message of messages) hash.update(JSON.stringify(messageRecord(message))).update('\n');
  return hash.digest('hex');
}

export function validCheckpoint(checkpoint: ContextCheckpoint | undefined, history: BaseMessage[]): checkpoint is ContextCheckpoint {
  return !!checkpoint && checkpoint.version === 1 && typeof checkpoint.summary === 'string'
    && checkpoint.summary.length > 0 && Number.isInteger(checkpoint.coveredMessages)
    && checkpoint.coveredMessages > 0 && checkpoint.coveredMessages <= history.length
    && checkpoint.prefixHash === historyHash(history.slice(0, checkpoint.coveredMessages));
}
