import {
  BASE_SYSTEM_PROMPT,
  FIRST_MESSAGE_ADDENDUM,
  SUBSEQUENT_MESSAGE_ADDENDUM,
} from './base-prompt.js';
import { generateToolListPrompt, generateToolUsageGuidelines } from './tool-prompt.js';
import {
  generateContextPrompt,
  generateEnvironmentPrompt,
  generateSecurityPrompt,
} from './context-prompt.js';
import { PromptContext, SystemPromptConfig } from './types.js';

export class SystemPromptBuilder {
  private config: SystemPromptConfig;

  constructor(config: SystemPromptConfig = {}) {
    this.config = {
      includeToolList: true,
      includeProjectInfo: true,
      includeUserInfo: true,
      ...config,
    };
  }

  build(context: PromptContext): string {
    const sections: string[] = [];

    sections.push(BASE_SYSTEM_PROMPT);

    if (this.config.includeProjectInfo || this.config.includeUserInfo) {
      sections.push(generateContextPrompt(context, this.config));
    }

    if (this.config.includeToolList && context.availableTools.length > 0) {
      sections.push(generateToolListPrompt(context.availableTools));
      sections.push(generateToolUsageGuidelines(context.availableTools));
    }

    sections.push(generateEnvironmentPrompt());
    sections.push(generateSecurityPrompt());

    if (this.config.customSections) {
      const sortedSections = this.config.customSections
        .filter(s => s.enabled)
        .sort((a, b) => b.priority - a.priority);
      
      sortedSections.forEach(section => {
        sections.push(`\n# ${section.name}\n${section.content}`);
      });
    }

    if (context.customInstructions) {
      sections.push(`\n# Custom Instructions\n${context.customInstructions}`);
    }

    if (context.isFirstMessage) {
      sections.push(FIRST_MESSAGE_ADDENDUM);
    } else {
      sections.push(SUBSEQUENT_MESSAGE_ADDENDUM);
    }

    return sections.join('\n');
  }

  updateConfig(config: Partial<SystemPromptConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): SystemPromptConfig {
    return { ...this.config };
  }
}

export function createSystemPrompt(context: PromptContext, config?: SystemPromptConfig): string {
  const builder = new SystemPromptBuilder(config);
  return builder.build(context);
}
