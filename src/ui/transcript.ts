import type { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { AgentSessionEvent } from '../runtime/types.js';
import type { SessionContext } from '../session/types.js';
import { messageText } from '../message-text.js';

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'notice';
  text: string;
  streaming?: boolean;
  label?: string;
  failed?: boolean;
}

export class Transcript {
  entries: TranscriptEntry[] = [];
  status = 'Ready';
  busy = false;
  private pending = new Map<string, TranscriptEntry>();
  private notices: TranscriptEntry[] = [];
  private serial = 0;

  sync(context: SessionContext): void {
    const entries: TranscriptEntry[] = [];
    const tools = new Map<string, TranscriptEntry>();
    for (const [index, message] of context.messages.entries()) {
      const id = message.id ?? `history-${index}`;
      const role = message._getType();
      const text = messageText(message.content);
      if (role === 'human' || role === 'ai') {
        this.pending.delete(id);
        if (text) entries.push({ id, role: role === 'human' ? 'user' : 'assistant', text });
      }
      if (role === 'ai') {
        for (const [i, call] of ((message as AIMessage).tool_calls ?? []).entries()) {
          const entry: TranscriptEntry = { id: `tool-${call.id ?? `${id}-${i}`}`, role: 'tool',
            label: call.name, text: toolPreview(call.args), streaming: true };
          entries.push(entry);
          if (call.id) tools.set(call.id, entry);
        }
      } else if (role === 'tool') {
        const result = message as ToolMessage;
        const entry = tools.get(result.tool_call_id);
        if (entry) {
          entry.text += '\n' + toolPreview(text || message.content);
          entry.streaming = false;
          entry.failed = result.status === 'error';
        }
      }
    }
    this.entries = [...entries, ...this.pending.values(), ...this.notices];
  }

  apply(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'session_updated': this.sync(event.context); break;
      case 'run_started': this.busy = true; this.status = 'Thinking…'; break;
      case 'text_delta': {
        let entry = this.pending.get(event.messageId);
        if (!entry) {
          entry = { id: event.messageId, role: 'assistant', text: '', streaming: true };
          this.pending.set(entry.id, entry);
          this.entries.push(entry);
        }
        entry.text += event.text;
        this.status = 'Writing…';
        break;
      }
      case 'tool_requested': this.status = `Running ${event.call.name}…`; break;
      case 'tool_result': this.status = 'Thinking…'; break;
      case 'agent_updated': this.status = `Subagent ${event.agent.id.slice(0, 12)}: ${event.agent.status}`; break;
      case 'run_finished':
        this.busy = false;
        this.status = event.run.status === 'completed' ? 'Ready' : event.run.status;
        for (const entry of this.pending.values()) {
          entry.streaming = false;
          entry.label = 'Assistant · interrupted';
        }
        for (const entry of this.entries) if (entry.role === 'tool' && entry.streaming) {
          entry.streaming = false;
          entry.failed = true;
          entry.text += '\nExecution ended before a result was received; outcome unknown.';
        }
        if (event.run.error) this.notice(event.run.error, true);
        break;
      default: break;
    }
  }

  notice(text: string, failed = false): void {
    const entry: TranscriptEntry = { id: `notice-${++this.serial}`, role: 'notice', text, failed };
    this.notices.push(entry);
    this.entries.push(entry);
  }

  clear(): void { this.entries = []; this.pending.clear(); this.notices = []; }
}

export function toolPreview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
  const lines = text.split('\n');
  const preview = lines.slice(0, 8).join('\n').slice(0, 1200);
  return preview + (lines.length > 8 || text.length > 1200 ? '\n… output truncated' : '');
}

/** Terminal output is data; never interpret embedded cursor/OSC control sequences. */
export function terminalText(text: string): string {
  /* eslint-disable no-control-regex -- These patterns intentionally remove terminal control bytes. */
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  /* eslint-enable no-control-regex */
}
