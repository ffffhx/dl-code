import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { Marked, type MarkedOptions } from 'marked';
import { useUI } from '../../store/index.js';
import TerminalRenderer from 'marked-terminal';
import chalk from 'chalk';
import { useTheme } from '../themes/index.js';

interface MarkdownRendererProps {
  content: string;
  color?: string;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, color }) => {
  const theme = useTheme();
  const { terminalWidth } = useUI();

  const renderedContent = useMemo(() => {
    const renderer = new TerminalRenderer({
      code: chalk.hex(theme.colors.syntax.keyword),
      codespan: chalk.hex(theme.colors.syntax.string),
      blockquote: chalk.hex(theme.colors.text.muted).italic,
      html: chalk.hex(theme.colors.syntax.tag),
      heading: chalk.hex(theme.colors.accent).bold,
      firstHeading: chalk.hex(theme.colors.accent).bold,
      hr: chalk.hex(theme.colors.border.light),
      listitem: chalk.hex(theme.colors.text.primary),
      table: chalk.hex(theme.colors.text.primary),
      paragraph: chalk.hex(theme.colors.text.primary),
      strong: chalk.hex(theme.colors.warning).bold,
      em: chalk.hex(theme.colors.info).italic,
      del: chalk.hex(theme.colors.text.muted).strikethrough,
      link: chalk.hex(theme.colors.accent).underline,
      href: chalk.hex(theme.colors.accent).underline,
      unescape: true,
      emoji: true,
      width: Math.max(1, terminalWidth - 2),
      showSectionPrefix: false,
      reflowText: true,
      tab: 2,
    });

    // marked-terminal 7 supports token objects; its separate typings still use the old API.
    const parser = new Marked();
    parser.setOptions({ renderer: renderer as unknown as MarkedOptions['renderer'] });

    try {
      const result = parser.parse(content);
      if (typeof result === 'string') {
        return result.trim();
      }
      return content;
    } catch {
      return content;
    }
  }, [content, theme, terminalWidth]);

  return (
    <Box flexDirection="column">
      <Text color={color}>{renderedContent}</Text>
    </Box>
  );
};
