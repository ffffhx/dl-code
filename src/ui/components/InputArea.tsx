import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useApp } from '../../store/index.js';
import { useTheme } from '../themes/index.js';
import { getAllCommands, getFilteredCommands, CommandInfo } from '../slash-commands/index.js';
import { SlashCommandMenu } from './SlashCommandMenu.js';

interface InputAreaProps {
  onSubmit: (message: string) => void;
}

export const InputArea: React.FC<InputAreaProps> = ({ onSubmit }) => {
  const [input, setInput] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const app = useApp();
  const theme = useTheme();

  const showCommandMenu = input.startsWith('/');
  
  const filteredCommands: CommandInfo[] = useMemo(() => {
    if (!showCommandMenu) return [];
    const searchTerm = input.slice(1);
    if (searchTerm === '') {
      return getAllCommands();
    }
    return getFilteredCommands(searchTerm);
  }, [input, showCommandMenu]);

  useInput((_inputChar, key) => {
    if (showCommandMenu && filteredCommands.length > 0) {
      if (key.upArrow) {
        setSelectedIndex(prev => 
          prev <= 0 ? filteredCommands.length - 1 : prev - 1
        );
        return;
      }
      if (key.downArrow) {
        setSelectedIndex(prev => 
          prev >= filteredCommands.length - 1 ? 0 : prev + 1
        );
        return;
      }
      if (key.tab) {
        const selectedCommand = filteredCommands[selectedIndex];
        if (selectedCommand) {
          setInput(`/${selectedCommand.name} `);
          setSelectedIndex(0);
        }
        return;
      }
    }

    if (key.return && !app.isProcessing) {
      if (showCommandMenu && filteredCommands.length > 0 && key.return) {
        const selectedCommand = filteredCommands[selectedIndex];
        if (selectedCommand && input === '/') {
          setInput(`/${selectedCommand.name}`);
          return;
        }
      }
      if (input.trim()) {
        onSubmit(input);
        setInput('');
        setSelectedIndex(0);
      }
    }

    if (key.escape && showCommandMenu) {
      setInput('');
      setSelectedIndex(0);
    }
  });

  const handleInputChange = (value: string) => {
    setInput(value);
    setSelectedIndex(0);
  };

  return (
    <Box flexDirection="column">
      <Box 
        flexDirection="row" 
        paddingX={2} 
        paddingY={0}
        borderStyle="single"
        borderColor={theme.colors.border.light}
      >
        <Text color={theme.colors.accent} bold>
          {'> '}
        </Text>
        {!app.isProcessing ? (
          <TextInput
            value={input}
            onChange={handleInputChange}
            placeholder="Type your message... (Press 'q' to quit)"
          />
        ) : (
          <Text color={theme.colors.text.muted}>Processing...</Text>
        )}
      </Box>
      <SlashCommandMenu
        commands={filteredCommands}
        selectedIndex={selectedIndex}
        visible={showCommandMenu}
      />
    </Box>
  );
};
