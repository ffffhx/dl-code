import React from 'react';
import { Box, Text } from 'ink';
import type { ThinkingStep } from '../../store/types.js';
import { useTheme } from '../themes/index.js';

interface ThinkingBlockProps {
  steps: ThinkingStep[];
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ steps }) => {
  const theme = useTheme();

  const renderStep = (step: ThinkingStep, index: number) => {
    if (step.type === 'tool_call') {
      const argsStr = step.args ? JSON.stringify(step.args, null, 2) : '';
      const displayArgs = argsStr.slice(0, 150) + (argsStr.length > 150 ? '...' : '');
      const hasArgs = Boolean(step.args);
      return (
        <Box key={`thinking-${index}`} flexDirection="column" marginLeft={2} marginBottom={1}>
          <Text color={theme.colors.warning} dimColor>
            🤔 Calling tool: <Text bold>{step.toolName}</Text>
          </Text>
          {hasArgs && (
            <Text color={theme.colors.text.muted} dimColor>
              Args: {displayArgs}
            </Text>
          )}
        </Box>
      );
    } else if (step.type === 'tool_result') {
      return (
        <Box key={`thinking-${index}`} flexDirection="column" marginLeft={2} marginBottom={1}>
          <Text color={theme.colors.info} dimColor>
            ✓ Tool result:
          </Text>
          <Text color={theme.colors.text.muted} dimColor>
            {typeof step.result === 'string' ? step.result.slice(0, 200) : ''}
            {typeof step.result === 'string' && step.result.length > 200 ? '...' : ''}
          </Text>
        </Box>
      );
    } else if (step.type === 'reasoning') {
      return (
        <Box key={`thinking-${index}`} flexDirection="column" marginLeft={2} marginBottom={1}>
          <Text color={theme.colors.primary} dimColor>
            💭 Thinking: {step.content}
          </Text>
        </Box>
      );
    }
    return null;
  };

  return (
    <Box 
      flexDirection="column" 
      marginTop={1} 
      borderStyle="round" 
      borderColor={theme.colors.border.light} 
      paddingX={1}
    >
      <Text color={theme.colors.warning} bold>
        🧠 AI Thinking Process:
      </Text>
      {steps.map((step, idx) => renderStep(step, idx))}
    </Box>
  );
};
