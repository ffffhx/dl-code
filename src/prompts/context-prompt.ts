import { PromptContext, SystemPromptConfig } from './types.js';

export function generateContextPrompt(context: PromptContext, config: SystemPromptConfig = {}): string {
  let prompt = '\n# Context Information\n';

  if (config.includeUserInfo !== false && context.userName) {
    prompt += `\nUser Name: ${context.userName}\n`;
  }

  if (config.includeProjectInfo !== false && context.projectRoot) {
    prompt += `Project Root Directory: ${context.projectRoot}\n`;
  }

  return prompt;
}

export function generateEnvironmentPrompt(): string {
  return `
# Environment Information

Operating System: ${process.platform}
Node Version: ${process.version}
Working Directory: ${process.cwd()}

# Important Notes
- All file paths should be absolute or relative to the project root
- Use platform-appropriate path separators
- Respect .gitignore patterns when searching files
- Be mindful of file permissions
`;
}

export function generateSecurityPrompt(): string {
  return `
# Security Guidelines

CRITICAL SECURITY RULES:
1. NEVER expose or log API keys, tokens, or credentials
2. NEVER commit secrets to the repository
3. ALWAYS validate user input before executing commands
4. AVOID destructive operations without explicit confirmation
5. BE CAUTIOUS with file deletion and modification
6. RESPECT user privacy and data protection

When handling sensitive operations:
- Ask for confirmation before destructive actions
- Warn users about potential risks
- Provide clear explanations of what will happen
- Offer safer alternatives when available
`;
}
