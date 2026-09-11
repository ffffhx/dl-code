import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { Transcript, terminalText, toolPreview } from '../src/ui/transcript.js';
import { messageText } from '../src/message-text.js';
import type { AgentSessionEvent, AgentSessionPayload } from '../src/runtime/types.js';
import type { SessionContext } from '../src/session/types.js';

const context = (): SessionContext => ({ sessionId: 's', userName: null, messages: [], todos: [], createdAt: 0, updatedAt: 0 });
const event = (payload: AgentSessionPayload): AgentSessionEvent => ({ ...payload, sequence: 1, timestamp: 0, sessionId: 's' });

test('streamed Markdown becomes one completed message without persisting partial chunks', () => {
  const state = new Transcript(); const c = context();
  c.messages.push(new HumanMessage({ id: 'user', content: 'Hello' })); state.sync(c);
  for (const text of ['中文 **bo', 'ld**']) state.apply(event({ type: 'text_delta', messageId: 'reply', text }));
  assert.equal(state.entries[1].text, '中文 **bold**');
  assert.equal(state.entries[1].streaming, true); assert.equal(c.messages.length, 1);
  c.messages.push(new AIMessage({ id: 'reply', content: '中文 **bold**' })); state.sync(c);
  assert.equal(state.entries.length, 2); assert.equal(state.entries[1].streaming, undefined);
  state.sync(c); assert.equal(state.entries.length, 2);
});

test('tool results update their call, remain in order, and have bounded previews', () => {
  const state = new Transcript(); const c = context();
  c.messages.push(new AIMessage({ id: 'a', content: 'Checking', tool_calls: [{ id: 't', name: 'ls', args: { path: '.' } }] }));
  state.sync(c); assert.equal(state.entries[1].streaming, true);
  c.messages.push(new ToolMessage({ tool_call_id: 't', content: 'file.ts', status: 'success' }));
  c.messages.push(new AIMessage({ id: 'b', content: 'Finished' })); state.sync(c);
  assert.deepEqual(state.entries.map(e => e.role), ['assistant', 'tool', 'assistant']);
  assert.match(state.entries[1].text, /file.ts/); assert.equal(state.entries[1].streaming, false);
  assert.ok(toolPreview('x'.repeat(90000)).length < 1300);
});

test('cancel preserves partial text as interrupted; clear removes transient state', () => {
  const state = new Transcript();
  const c = context();
  c.messages.push(new AIMessage({ id: 'call', content: '', tool_calls: [{ id: 't', name: 'edit', args: {} }] }));
  state.sync(c);
  state.apply(event({ type: 'text_delta', messageId: 'partial', text: 'unfinished ```' }));
  state.apply(event({ type: 'run_finished', run: { id: 'r', startedAt: 0, status: 'cancelled', error: 'Cancelled' } }));
  assert.equal(state.entries[0].failed, true); assert.match(state.entries[0].text, /outcome unknown/);
  assert.equal(state.entries[1].streaming, false); assert.match(state.entries[1].label!, /interrupted/);
  state.clear(); state.sync(context()); assert.deepEqual(state.entries, []);
});

test('text extraction ignores metadata and terminal controls', () => {
  assert.equal(messageText([{ type: 'text', text: 'hello' }, { type: 'reasoning', text: 'private' }, { type: 'image', url: 'x' }]), 'hello');
  assert.equal(terminalText('\x1b[2Jhello\x1b]52;c;ZXZpbA==\x07中文\n'), 'hello中文\n');
});
