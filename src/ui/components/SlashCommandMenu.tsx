import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../themes/index.js';
import { CommandInfo } from '../slash-commands/index.js';

interface SlashCommandMenuProps {
  commands: CommandInfo[];
  selectedIndex: number;
  visible: boolean;
}

export const SlashCommandMenu: React.FC<SlashCommandMenuProps> = ({
  commands,
  selectedIndex,
  visible,
}) => {
  const theme = useTheme();

  if (!visible || commands.length === 0) {
    return null;
  }

  const displayCommands = commands.slice(0, 8);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.colors.border.light}
      paddingX={1}
      marginBottom={0}
    >
      {displayCommands.map((cmd, index) => {
        const isSelected = index === selectedIndex;
        return (
          <Box key={cmd.name} flexDirection="row">
            <Box width={20}>
              <Text
                color={isSelected ? theme.colors.info : theme.colors.text.muted}
                bold={isSelected}
              >
                /{cmd.name}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text color={theme.colors.text.muted}>
                {cmd.description}
              </Text>
            </Box>
          </Box>
        );
      })}
      {commands.length > 8 && (
        <Text color={theme.colors.text.muted} dimColor>
          ... and {commands.length - 8} more
        </Text>
      )}
    </Box>
  );
};
