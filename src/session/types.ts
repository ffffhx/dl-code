import { BaseMessage } from '@langchain/core/messages';
import { TodoItem } from '../tools/todo/types.js';
import { TokenUsage } from '../context/index.js';
import type { ActiveSkill } from '../skills/types.js';
import type { ContextCheckpoint } from '../context/history.js';

export interface SessionContext {
  sessionId: string;
  messages: BaseMessage[];
  userName: string | null;
  todos: TodoItem[];
  createdAt: number;
  updatedAt: number;
  tokenUsage?: TokenUsage;
  compressionCount?: number;
  contextCheckpoint?: ContextCheckpoint;
  activeSkills?: ActiveSkill[];
}

export interface SessionMetadata {
  sessionId: string;
  userName: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}
