import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { useUI, useStoreActions } from '../store/index.js';
import { CodingAgent } from '../agents/coding-agent.js';
import { SessionManager } from '../session/index.js';
import { MessageArea, InputArea, TodoPanel } from './components/index.js';
import { startupLogger, StartupMessage } from '../utils/startup-logger.js';
import { themeManager } from './themes/index.js';
import { useAppStore } from '../store/app-store.js';
import { createAgentManager } from '../agents/subagents/runtime.js';
import { createSubagentTools } from '../agents/subagents/tools.js';
import { getGlobalMCPManager } from '../mcp/index.js';
import { isSlashCommand, executeSlashCommand, SlashCommandContext } from './slash-commands/index.js';

export const App: React.FC = () => {
  const ui = useUI();
  const {
    addUserMessage,
    addSystemMessage,
    setIsProcessing,
    addThinkingStep,
    clearThinkingSteps,
    updateStreamingBuffer,
    startStreaming,
    endStreaming,
    setTodos,
    addTerminalOutput,
    setIsGenerating,
    clearMessages,
    toggleTodoPanel,
    setTheme,
    initSession,
    setMessages,
    getSessionContext,
  } = useStoreActions();

  const [sessionManager] = useState(() => new SessionManager());
  const [agent] = useState(() => new CodingAgent());
  const [agentManager] = useState(() => createAgentManager(sessionManager.getCurrentSession().sessionId));
  const rootController = useRef<AbortController | null>(null);
  const shuttingDown = useRef(false);
  const [childStatus, setChildStatus] = useState('');
  const shutdown = async () => {
    if (shuttingDown.current) return;
    shuttingDown.current = true;
    rootController.current?.abort(new Error('Application shutting down'));
    await agentManager.shutdown();
    await agent.cleanup();
    await getGlobalMCPManager().disconnectAll();
    process.exit(0);
  };
  useInput((input, key) => { if (key.ctrl && input === 'c') void shutdown(); });
  const [, setStartupMessages] = useState<StartupMessage[]>(() =>
    startupLogger.getMessages()
  );
  const [, setShowStartupMessages] = useState(true);

  const theme = themeManager.getTheme();

  useEffect(() => {
    const session = agentManager.recoveredRootContext() ?? sessionManager.getCurrentSession();
    initSession(session);
    const unsubscribe = agentManager.subscribe(record => {
      if (record.parentId) setChildStatus(`${record.id.slice(0, 14)}: ${record.status}`);
    });
    const stop = () => { void shutdown(); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    return () => { unsubscribe(); process.off('SIGTERM', stop); process.off('SIGINT', stop); };
  }, []);

  useEffect(() => {
    const unsubscribe = startupLogger.subscribe((messages) => {
      setStartupMessages(messages);
    });
    
    const hideTimer = setTimeout(() => {
      setShowStartupMessages(false);
    }, 5000);
    
    return () => {
      unsubscribe();
      clearTimeout(hideTimer);
    };
  }, []);

  const slashCommandContext: SlashCommandContext = {
    clearMessages,
    toggleTodoPanel,
    setTheme: (themeName: string) => {
      setTheme(themeName);
      themeManager.setTheme(themeName);
    },
    exitApp: () => { void shutdown(); },
  };

  const handleUserMessage = async (userInput: string) => {
    if (userInput === 'q' || userInput === 'exit' || userInput === 'quit') {
      await shutdown();
      return;
    }

    if (isSlashCommand(userInput)) {
      const result = executeSlashCommand(userInput, slashCommandContext);
      
      if (result.message) {
        addSystemMessage(result.message);
      }
      if (result.action === 'exit') {
        void shutdown();
      }
      return;
    }

    addUserMessage(userInput);
    
    setIsProcessing(true);
    setIsGenerating(true);
    clearThinkingSteps();

    const streamingId = `msg-${Date.now()}`;
    // 标记流式响应开始
    startStreaming(streamingId);

    try {
      const currentContext = getSessionContext();
      agentManager.attachRoot(currentContext);
      const controller = new AbortController();
      rootController.current = controller;
      const stream = agent.execute(currentContext, (context) => {
        const state = useAppStore.getState();
        state.setMessages([...context.messages]);
        state.setActiveSkills(context.activeSkills ?? []);
        if (context.tokenUsage) state.setTokenUsage(context.tokenUsage);
        state.setCompressionCount(context.compressionCount ?? 0);
        state.setContextCheckpoint(context.contextCheckpoint);
        sessionManager.saveSession(state.getSessionContext());
        agentManager.update(currentContext.sessionId, context);
      }, {
        signal: controller.signal,
        takeMessages: () => agentManager.takeMessages(currentContext.sessionId),
        tools: createSubagentTools(agentManager, controller.signal),
      });

      const newMessages = currentContext.messages;
      let streamBuffer = '';

      for await (const chunk of stream) {
        // 处理 model_request 节点消息 (agent 的模型调用结果)
        if (chunk.model_request) {
          const agentMessages = chunk.model_request.messages || [];
          agentMessages.forEach((msg: any) => {
            
            // 工具调用请求
            if (msg.tool_calls) {
              msg.tool_calls.forEach((toolCall: any) => {
                addThinkingStep({
                  type: 'tool_call',
                  timestamp: Date.now(),
                  content: `Calling ${toolCall.name}`,
                  toolName: toolCall.name,
                  args: toolCall.args,
                });

                if (toolCall.name === 'bash' || toolCall.name === 'tree' || toolCall.name === 'grep' || toolCall.name === 'ls') {
                  addTerminalOutput(`$ ${toolCall.name} ${JSON.stringify(toolCall.args)}`);
                } else if (toolCall.name === 'todo_write') {
                  const updatedTodos = toolCall.args.todos;
                  setTodos(updatedTodos);
                  setMessages(newMessages);
                  const updatedContext = getSessionContext();
                  sessionManager.saveSession(updatedContext);
                }
              });
            }

            if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
              streamBuffer += msg.content;
              updateStreamingBuffer(streamBuffer);
              
              addThinkingStep({
                type: 'reasoning',
                timestamp: Date.now(),
                content: msg.content.slice(0, 100),
              });
            }
          });
        }
        
        // 处理工具执行结果
        if (chunk.tools) {
          const toolMessages = chunk.tools.messages || [];
          toolMessages.forEach((msg: any) => {
            
            if (msg.content && typeof msg.content === 'string') {
              addThinkingStep({
                type: 'tool_result',
                timestamp: Date.now(),
                content: 'Tool returned result',
                result: msg.content,
              });

              const lines = msg.content.split('\n').slice(0, 5);
              addTerminalOutput(lines.join('\n'));
            }
          });
        }
      }

      endStreaming();

      setMessages(newMessages);
      const finalContext = getSessionContext();
      sessionManager.saveSession(finalContext);
    } catch (error) {
      addTerminalOutput(`Error: ${error}`);
      endStreaming();
    } finally {
      rootController.current = null;
      agentManager.finishRoot();
      setIsProcessing(false);
      setIsGenerating(false);
      // clearThinkingSteps();
    }
  };

  return (
    <Box flexDirection="column" height="100%">
      {childStatus && <Text dimColor>Subagent {childStatus}</Text>}
      <Box borderStyle="single" borderColor={theme.colors.accent} paddingX={1}>
        <Text bold color={theme.colors.accent}>
           DeerCode - AI Coding Assistant
        </Text>
        <Text color={theme.colors.text.muted}> 开发中 </Text>
      </Box>   
      <Box flexGrow={1} flexDirection="column">
        <MessageArea />
        {ui.showTodoPanel && <TodoPanel />}
      </Box>
      <InputArea onSubmit={handleUserMessage} />
    </Box>
  );
};
