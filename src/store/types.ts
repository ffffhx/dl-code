import type { BaseMessage } from '@langchain/core/messages';
import type { TokenUsage } from '../context/index.js';
import type { ActiveSkill } from '../skills/types.js';
import type { ContextCheckpoint } from '../context/history.js';

export enum FocusId {
  MAIN_INPUT = 'mainInput',
  MESSAGE_AREA = 'messageArea',
  THEME_SELECTOR = 'themeSelector',
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  toolResult?: string;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface Todo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
}

export interface ThinkingStep {
  type: 'tool_call' | 'tool_result' | 'reasoning';
  timestamp: number;
  content: string;
  toolName?: string;
  args?: unknown;
  result?: string;
}

export type ActiveModal = 
  | 'themeSelector'
  | 'shortcuts'
  | null;

export interface AppState {
  currentFocus: FocusId;
  activeModal: ActiveModal;
  isProcessing: boolean;
  currentTheme: string;
}

export interface SessionState {
  sessionId: string;
  messages: BaseMessage[];
  displayMessages: Message[];
  todos: Todo[];
  thinkingSteps: ThinkingStep[];
  currentStreamingBuffer: string;
  currentStreamingMessageId: string | null;
  userName: string | null;
  createdAt: number;
  updatedAt: number;
  tokenUsage?: TokenUsage;
  compressionCount?: number;
  contextCheckpoint?: ContextCheckpoint;
  activeSkills?: ActiveSkill[];
}

export interface UIState {
  terminalWidth: number;
  terminalHeight: number;
  showTodoPanel: boolean;
  historyExpanded: boolean;
}

export interface OpenFile {
  path: string;
  content: string;
}
