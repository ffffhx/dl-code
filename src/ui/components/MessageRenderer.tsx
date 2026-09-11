import React from 'react';
import { Box, Text } from 'ink';
import type { Message } from '../../store/types.js';
import { useTheme } from '../themes/index.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';

interface MessageRendererProps {
  message: Message;
}

export const MessageRenderer: React.FC<MessageRendererProps> = ({ message }) => {
  const theme = useTheme();

  const renderUserMessage = () => (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={theme.colors.accent}>
        You:
      </Text>
      <Text color={theme.colors.text.primary}>{message.content}</Text>
    </Box>
  );

  const renderAssistantMessage = () => (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={theme.colors.success}>
        Assistant:
      </Text>
      <MarkdownRenderer content={message.content} />
      {message.toolCalls && message.toolCalls.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {message.toolCalls.map((toolCall, i) => (
            <Text key={i} color={theme.colors.warning}>
              🔧 {toolCall.name}({JSON.stringify(toolCall.args).slice(0, 50)}...)
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );

  const renderToolMessage = () => (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.colors.text.muted} dimColor>
        Tool Result:
      </Text>
      <Text color={theme.colors.text.muted} dimColor>
        {message.content.slice(0, 200)}
        {message.content.length > 200 ? '...' : ''}
      </Text>
    </Box>
  );

  const renderSystemMessage = () => (
    <Box flexDirection="column" marginBottom={1} paddingX={1}>
      <Box borderStyle="round" borderColor={theme.colors.info || theme.colors.accent} paddingX={1}>
        <Text color={theme.colors.info || theme.colors.accent}>
          {message.content}
        </Text>
      </Box>
    </Box>
  );

  switch (message.role) {
    case 'user':
      return renderUserMessage();
    case 'assistant':
      return renderAssistantMessage();
    case 'tool':
      return renderToolMessage();
    case 'system':
      return renderSystemMessage();
    default:
      return null;
  }
};
