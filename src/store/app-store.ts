import { randomUUID } from 'node:crypto';
import { create } from 'zustand';
import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import type { 
  AppState, 
  SessionState, 
  UIState, 
  Message, 
  Todo, 
  ThinkingStep,
  FocusId,
  ActiveModal 
} from './types.js';
import type { TokenUsage } from '../context/index.js';
import type { SessionContext } from '../session/index.js';
import { TodoStatus, TodoPriority } from '../tools/todo/types.js';
import type { ActiveSkill } from '../skills/types.js';

export interface Store {
  app: AppState;
  session: SessionState;
  ui: UIState;

  setFocus: (focus: FocusId) => void;
  setActiveModal: (modal: ActiveModal) => void;
  closeModal: () => void;
  setIsProcessing: (isProcessing: boolean) => void;
  setTheme: (theme: string) => void;

  addUserMessage: (content: string) => void;
  addAssistantMessage: (content: string) => void;
  addToolMessage: (content: string) => void;
  addSystemMessage: (content: string) => void;
  updateStreamingBuffer: (buffer: string) => void;
  startStreaming: (messageId: string) => void;
  endStreaming: () => void;
  clearMessages: () => void;

  setTodos: (todos: Todo[]) => void;
  addTodo: (todo: Todo) => void;
  updateTodo: (id: string, updates: Partial<Todo>) => void;
  removeTodo: (id: string) => void;

  addThinkingStep: (step: ThinkingStep) => void;
  clearThinkingSteps: () => void;

  setTerminalSize: (width: number, height: number) => void;
  toggleTodoPanel: () => void;
  toggleHistoryExpanded: () => void;

  openFile: (path: string, content: string) => void;
  setActiveFile: (path: string | null) => void;
  addTerminalOutput: (output: string) => void;
  clearTerminalOutput: () => void;
  setIsGenerating: (isGenerating: boolean) => void;

  initSession: (context: SessionContext) => void;
  syncHarnessSession: (context: SessionContext) => void;
  addMessage: (message: BaseMessage) => void;
  setMessages: (messages: BaseMessage[]) => void;
  setTokenUsage: (usage: TokenUsage) => void;
  setCompressionCount: (count: number) => void;
  setContextCheckpoint: (checkpoint: SessionContext['contextCheckpoint']) => void;
  setActiveSkills: (skills: ActiveSkill[]) => void;
  getSessionContext: () => SessionContext;

  openFiles: Array<{ path: string; content: string }>;
  activeFilePath: string | null;
  terminalOutput: string[];
  isGenerating: boolean;
}

// Zustand核心：一个函数创建store，一个hook使用store
export const useAppStore = create<Store>((set) => ({
  // 状态

  app: {
    currentFocus: 'mainInput' as FocusId,
    activeModal: null,
    isProcessing: false,
    currentTheme: 'ayu-dark',
  },

  // 核心状态
  session: {
    sessionId: `session-${Date.now()}`,
    // LangChain 格式的消息数组、存储发送给 LLM 的完整对话历史，用于上下文管理和 API 调用
    messages: [],
    // 用于 UI 展示的消息数组
    displayMessages: [],
    // 存储 AI 助手创建的待办事项
    todos: [],
    // AI 的思考步骤记录，包括tool_call、tool_result、reasoning
    thinkingSteps: [],
    // 当前流式输出的缓冲区
    currentStreamingBuffer: '',
    // 当前正在流式输出的消息ID
    currentStreamingMessageId: null,
    userName: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tokenUsage: undefined,
    // 上下文压缩次数
    compressionCount: undefined,
    activeSkills: [],
  },

  ui: {
    terminalWidth: process.stdout.columns || 80,
    terminalHeight: process.stdout.rows || 24,
    showTodoPanel: false,
    historyExpanded: true,
  },

  openFiles: [],
  activeFilePath: null,
  terminalOutput: [],
  isGenerating: false,

  // actions（修改状态的方法）
  setFocus: (focus) =>
    set((state) => ({
      app: { ...state.app, currentFocus: focus },
    })),

  setActiveModal: (modal) =>
    set((state) => ({
      app: { ...state.app, activeModal: modal },
    })),

  closeModal: () =>
    set((state) => ({
      app: { ...state.app, activeModal: null },
    })),

  setIsProcessing: (isProcessing) =>
    set((state) => ({
      app: { ...state.app, isProcessing },
    })),

  setTheme: (theme) =>
    set((state) => ({
      app: { ...state.app, currentTheme: theme },
    })),

  addUserMessage: (content) =>
    set((state) => {
      const message = new HumanMessage(content);
      const displayMessage: Message = {
        id: `msg-${randomUUID()}`,
        role: 'user',
        content,
        timestamp: Date.now(),
      };
      return {
        session: {
          ...state.session,
          messages: [...state.session.messages, message],
          displayMessages: [...state.session.displayMessages, displayMessage],
        },
      };
    }),

  addAssistantMessage: (content) =>
    set((state) => {
      const message = new AIMessage(content);
      const displayMessage: Message = {
        id: `msg-${randomUUID()}`,
        role: 'assistant',
        content,
        timestamp: Date.now(),
      };
      return {
        session: {
          ...state.session,
          messages: [...state.session.messages, message],
          displayMessages: [...state.session.displayMessages, displayMessage],
        },
      };
    }),

  addToolMessage: (content) =>
    set((state) => {
      const displayMessage: Message = {
        id: `msg-${randomUUID()}`,
        role: 'tool',
        content,
        timestamp: Date.now(),
        toolResult: content,
      };
      return {
        session: {
          ...state.session,
          displayMessages: [...state.session.displayMessages, displayMessage],
        },
      };
    }),

  addSystemMessage: (content) =>
    set((state) => {
      const displayMessage: Message = {
        id: `msg-${randomUUID()}`,
        role: 'system',
        content,
        timestamp: Date.now(),
      };
      return {
        session: {
          ...state.session,
          displayMessages: [...state.session.displayMessages, displayMessage],
        },
      };
    }),

  updateStreamingBuffer: (buffer) =>
    set((state) => ({
      session: {
        ...state.session,
        currentStreamingBuffer: buffer,
      },
    })),

  startStreaming: (messageId) =>
    set((state) => ({
      session: {
        ...state.session,
        currentStreamingMessageId: messageId,
        currentStreamingBuffer: '',
      },
    })),

  endStreaming: () =>
    set((state) => {
      const { currentStreamingBuffer, currentStreamingMessageId } = state.session;
      if (currentStreamingBuffer && currentStreamingMessageId) {
        const message = new AIMessage(currentStreamingBuffer);
        const displayMessage: Message = {
          id: currentStreamingMessageId,
          role: 'assistant',
          content: currentStreamingBuffer,
          timestamp: Date.now(),
        };
        return {
          session: {
            ...state.session,
            messages: [...state.session.messages, message],
            displayMessages: [...state.session.displayMessages, displayMessage],
            currentStreamingBuffer: '',
            currentStreamingMessageId: null,
          },
        };
      }
      return {
        session: {
          ...state.session,
          currentStreamingBuffer: '',
          currentStreamingMessageId: null,
        },
      };
    }),

  clearMessages: () =>
    set((state) => ({
      session: {
        ...state.session,
        messages: [],
        displayMessages: [],
        thinkingSteps: [],
        currentStreamingBuffer: '',
        currentStreamingMessageId: null,
        activeSkills: [],
        contextCheckpoint: undefined,
        compressionCount: 0,
        tokenUsage: undefined,
      },
    })),

  setTodos: (todos) =>
    set((state) => ({
      session: {
        ...state.session,
        todos,
      },
    })),

  addTodo: (todo) =>
    set((state) => ({
      session: {
        ...state.session,
        todos: [...state.session.todos, todo],
      },
    })),

  updateTodo: (id, updates) =>
    set((state) => ({
      session: {
        ...state.session,
        todos: state.session.todos.map((todo) =>
          todo.id === id ? { ...todo, ...updates } : todo
        ),
      },
    })),

  removeTodo: (id) =>
    set((state) => ({
      session: {
        ...state.session,
        todos: state.session.todos.filter((todo) => todo.id !== id),
      },
    })),

  addThinkingStep: (step) =>
    set((state) => ({
      session: {
        ...state.session,
        thinkingSteps: [...state.session.thinkingSteps, step],
      },
    })),

  clearThinkingSteps: () =>
    set((state) => ({
      session: {
        ...state.session,
        thinkingSteps: [],
      },
    })),

  setTerminalSize: (width, height) =>
    set((state) => ({
      ui: {
        ...state.ui,
        terminalWidth: width,
        terminalHeight: height,
      },
    })),

  toggleTodoPanel: () =>
    set((state) => ({
      ui: {
        ...state.ui,
        showTodoPanel: !state.ui.showTodoPanel,
      },
    })),

  toggleHistoryExpanded: () =>
    set((state) => ({
      ui: {
        ...state.ui,
        historyExpanded: !state.ui.historyExpanded,
      },
    })),

  openFile: (path, content) =>
    set((state) => {
      const existingIndex = state.openFiles.findIndex((f) => f.path === path);
      if (existingIndex >= 0) {
        const newFiles = [...state.openFiles];
        newFiles[existingIndex] = { path, content };
        return {
          openFiles: newFiles,
          activeFilePath: path,
        };
      }
      return {
        openFiles: [...state.openFiles, { path, content }],
        activeFilePath: path,
      };
    }),

  setActiveFile: (path) =>
    set({
      activeFilePath: path,
    }),

  addTerminalOutput: (output) =>
    set((state) => ({
      terminalOutput: [...state.terminalOutput, output],
    })),

  clearTerminalOutput: () =>
    set({
      terminalOutput: [],
    }),

  setIsGenerating: (isGenerating) =>
    set({
      isGenerating,
    }),

  initSession: (context: SessionContext) =>
    set((state) => {
      const todos: Todo[] = context.todos.map((t) => ({
        id: t.id,
        content: t.content,
        status: t.status as Todo['status'],
        priority: (t.priority || 'medium') as Todo['priority'],
      }));
      return {
        session: {
          ...state.session,
          sessionId: context.sessionId,
          lastRun: context.lastRun,
          messages: context.messages,
          userName: context.userName,
          todos,
          createdAt: context.createdAt,
          updatedAt: context.updatedAt,
          tokenUsage: context.tokenUsage,
          compressionCount: context.compressionCount,
          contextCheckpoint: context.contextCheckpoint,
          activeSkills: context.activeSkills ?? [],
        },
      };
    }),

  syncHarnessSession: (context) => {
    useAppStore.getState().initSession(context);
    set(state => ({ session: { ...state.session, displayMessages: context.messages
      .filter(message => (message._getType() === 'human' || message._getType() === 'ai') && message.content)
      .map((message, index) => ({
        id: message.id ?? `${context.sessionId}-${index}`,
        role: message._getType() === 'human' ? 'user' as const : 'assistant' as const,
        content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        timestamp: context.updatedAt,
      })) } }));
  },

  addMessage: (message) =>
    set((state) => ({
      session: {
        ...state.session,
        messages: [...state.session.messages, message],
        updatedAt: Date.now(),
      },
    })),

  setMessages: (messages) =>
    set((state) => ({
      session: {
        ...state.session,
        messages,
        updatedAt: Date.now(),
      },
    })),

  setTokenUsage: (usage) =>
    set((state) => ({
      session: {
        ...state.session,
        tokenUsage: usage,
      },
    })),

  setCompressionCount: (count) =>
    set((state) => ({
      session: {
        ...state.session,
        compressionCount: count,
      },
    })),

  getSessionContext: (): SessionContext => {
    const store = useAppStore.getState();
    return {
      sessionId: store.session.sessionId,
      lastRun: store.session.lastRun,
      messages: store.session.messages,
      userName: store.session.userName,
      todos: store.session.todos.map((t: Todo) => ({
        id: t.id,
        content: t.content,
        status: TodoStatus[t.status as keyof typeof TodoStatus],
        priority: TodoPriority[t.priority as keyof typeof TodoPriority],
      })),
      createdAt: store.session.createdAt,
      updatedAt: store.session.updatedAt,
      tokenUsage: store.session.tokenUsage,
      compressionCount: store.session.compressionCount,
      contextCheckpoint: store.session.contextCheckpoint,
      activeSkills: store.session.activeSkills ?? [],
    };
  },
  setActiveSkills: (skills) =>
    set((state) => ({ session: { ...state.session, activeSkills: [...skills] } })),
  setContextCheckpoint: (checkpoint) =>
    set((state) => ({ session: { ...state.session, contextCheckpoint: checkpoint } })),
}));
