import { AIMessage, BaseMessage, ToolMessage } from '@langchain/core/messages';
import { encodingForModel, TiktokenModel } from 'js-tiktoken';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export class TokenCounter {
  private encoding?: ReturnType<typeof encodingForModel>;

  constructor(modelName: string = 'gpt-4') {
    try {
      this.encoding = encodingForModel(modelName as TiktokenModel);
    } catch {
      this.encoding = encodingForModel('gpt-4');
    }
  }

  countTokens(text: string): number {
    if (!text) return 0;
    try {
      const tokens = this.encoding?.encode(text, [], []);
      return tokens?.length ?? Math.ceil(text.length / 4);
    } catch {
      return Math.ceil(text.length / 4);
    }
  }

  countMessageTokens(message: BaseMessage): number {
    let tokens = 0;
    
    if (typeof message.content === 'string') {
      tokens += this.countTokens(message.content);
    } else if (Array.isArray(message.content)) {
      for (const content of message.content) {
        if (typeof content === 'string') {
          tokens += this.countTokens(content);
        } else if (typeof content === 'object' && content !== null && 'type' in content && content.type === 'text' && 'text' in content) {
          tokens += this.countTokens(String(content.text));
        } else {
          // Multimedia is provider-dependent; include a conservative placeholder estimate.
          tokens += Math.max(1024, this.countTokens(JSON.stringify(content)));
        }
      }
    }

    tokens += 4;

    if (message.additional_kwargs) {
      const additionalStr = JSON.stringify(message.additional_kwargs);
      tokens += this.countTokens(additionalStr);
    }

    const calls = (message as AIMessage).tool_calls;
    if (calls?.length && !message.additional_kwargs?.tool_calls) tokens += this.countTokens(JSON.stringify(calls));
    const toolCallId = (message as ToolMessage).tool_call_id;
    if (toolCallId) tokens += this.countTokens(toolCallId);

    return tokens;
  }

  countMessagesTokens(messages: BaseMessage[]): number {
    let totalTokens = 0;
    for (const message of messages) {
      totalTokens += this.countMessageTokens(message);
    }
    totalTokens += 3;
    return totalTokens;
  }

  getUsage(messages: BaseMessage[]): TokenUsage {
    // Every historical message is input to the next request, including AI replies.
    const inputTokens = this.countMessagesTokens(messages);
    return {
      inputTokens,
      outputTokens: 0,
      totalTokens: inputTokens,
    };
  }

  /** A leading substring that fits a token budget, without slicing UTF-16 pairs. */
  take(text: string, maxTokens: number): string {
    if (maxTokens <= 0) return '';
    if (this.countTokens(text) <= maxTokens) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.countTokens(text.slice(0, mid)) <= maxTokens) low = mid;
      else high = mid - 1;
    }
    if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low--;
    return text.slice(0, low);
  }

  free(): void {
    // js-tiktoken owns JS memory, not a WASM allocation with a free() method.
    this.encoding = undefined;
  }
}
