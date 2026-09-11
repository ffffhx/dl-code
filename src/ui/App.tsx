import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { useUI } from '../store/index.js';
import { useAppStore } from '../store/app-store.js';
import { MessageArea, InputArea, TodoPanel } from './components/index.js';
import { themeManager, useTheme } from './themes/index.js';
import type { HarnessRuntime, HarnessEvent } from '../harness/index.js';
import { isSlashCommand, executeSlashCommand } from './slash-commands/index.js';

export const App: React.FC<{ harness: HarnessRuntime }> = ({ harness }) => {
  const ui = useUI();
  const { exit } = useApp();
  const [childStatus, setChildStatus] = useState('');
  const shuttingDown = useRef(false);
  const theme = useTheme();
  const { stdout } = useStdout();

  useEffect(() => {
    const resize = () => useAppStore.getState().setTerminalSize(stdout.columns || 80, stdout.rows || 24);
    resize();
    stdout.on('resize', resize);
    return () => { stdout.off('resize', resize); };
  }, [stdout]);

  const shutdown = async () => {
    if (shuttingDown.current) return;
    shuttingDown.current = true;
    try { await harness.shutdown(); exit(); }
    catch (error) { exit(error instanceof Error ? error : new Error(String(error))); }
  };
  useInput((input, key) => {
    if (key.ctrl && input === 'c') void shutdown();
    else if (key.escape && harness.activeRunId) void harness.cancel(harness.activeRunId)
      .catch(error => useAppStore.getState().addSystemMessage('Error: ' + String(error)));
  });

  useEffect(() => {
    useAppStore.getState().syncHarnessSession(harness.snapshot());
    const onEvent = (event: HarnessEvent) => {
      const state = useAppStore.getState();
      switch (event.type) {
        case 'session_updated':
          state.syncHarnessSession(event.context);
          break;
        case 'run_started':
          state.clearThinkingSteps();
          setChildStatus('');
          state.setIsProcessing(true);
          state.setIsGenerating(true);
          break;
        case 'tool_requested':
          state.addThinkingStep({ type: 'tool_call', timestamp: event.timestamp,
            content: 'Calling ' + event.call.name, toolName: event.call.name, args: event.call.args });
          break;
        case 'tool_result':
          state.addThinkingStep({ type: 'tool_result', timestamp: event.timestamp,
            content: 'Tool returned result', result: typeof event.content === 'string' ? event.content : JSON.stringify(event.content) });
          state.addTerminalOutput((typeof event.content === 'string' ? event.content : JSON.stringify(event.content)).split('\n').slice(0, 5).join('\n'));
          break;
        case 'agent_updated':
          setChildStatus(event.agent.id.slice(0, 14) + ': ' + event.agent.status);
          break;
        case 'run_finished':
          if (event.run.error) state.addSystemMessage(event.run.status + ': ' + event.run.error);
          state.setIsProcessing(false);
          state.setIsGenerating(false);
          break;
        default: break;
      }
    };
    const unsubscribe = harness.subscribe(onEvent);
    const stop = () => { void shutdown(); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    return () => {
      unsubscribe();
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
    };
  }, [harness]);

  const handleUserMessage = async (input: string) => {
    const state = useAppStore.getState();
    try {
      if (['q', 'exit', 'quit'].includes(input)) { await shutdown(); return; }
      if (isSlashCommand(input)) {
        const result = executeSlashCommand(input, {
          clearMessages: () => {
            harness.clear();
            state.clearMessages();
            setChildStatus('');
          },
          toggleTodoPanel: state.toggleTodoPanel,
          setTheme: name => { state.setTheme(name); themeManager.setTheme(name); },
          exitApp: () => { void shutdown(); },
        });
        if (result.message) state.addSystemMessage(result.message);
        if (result.action === 'exit') await shutdown();
        if (result.action === 'resume') {
          const run = harness.snapshot().lastRun;
          if (!run) throw new Error('No interrupted run to resume');
          for await (const event of harness.resume(run.id)) void event;
        }
        return;
      }
      for await (const event of harness.run({ text: input })) void event;
    } catch (error) {
      state.addSystemMessage('Error: ' + String(error));
      state.setIsProcessing(false);
      state.setIsGenerating(false);
    }
  };

  return (
    <Box flexDirection="column" width={ui.terminalWidth}>
      {childStatus && <Text dimColor>Subagent {childStatus}</Text>}
      <Box borderStyle="single" borderColor={theme.colors.accent} paddingX={1}>
        <Text bold color={theme.colors.accent}>DeerCode - AI Coding Assistant</Text>
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
