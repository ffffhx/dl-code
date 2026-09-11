import assert from 'node:assert/strict';
import { createTestRenderer } from '@opentui/core/testing';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { TerminalApp } from '../src/ui/terminal-app.js';
import { themeManager } from '../src/ui/themes/ThemeManager.js';
import type { AgentSession } from '../src/runtime/index.js';
import type { AgentSessionEvent, AgentSessionPayload } from '../src/runtime/types.js';
import type { SessionContext } from '../src/session/types.js';

const c: SessionContext = { sessionId: 'test', userName: null, messages: [], todos: [], createdAt: 0, updatedAt: 0 };
let listener: ((event: AgentSessionEvent) => void) | undefined;
let sequence = 0; let closed = 0; let cancelled = 0; let exited = 0;
const send = (payload: AgentSessionPayload) => listener?.({ ...payload, sessionId: 'test', sequence: ++sequence, timestamp: 0 });
const fake = {
  activeRunId: undefined as string | undefined,
  snapshot: () => c,
  subscribe: (next: typeof listener) => { listener = next; return () => { listener = undefined; }; },
  shutdown: async () => { closed++; },
  cancel: async () => { cancelled++; fake.activeRunId = undefined; },
  clear: () => { c.messages = []; send({ type: 'session_updated', context: c }); },
  run: async function* ({ text }: { text: string }) {
    c.messages.push(new HumanMessage({ id: `u-${sequence}`, content: text }));
    send({ type: 'session_updated', context: c }); yield {};
  },
};
const ui = await createTestRenderer({ width: 90, height: 28, kittyKeyboard: true });
const app = new TerminalApp(ui.renderer, fake as unknown as AgentSession, () => { exited++; });
async function frameContaining(text: string): Promise<string> {
  // Tree-sitter workers can finish after the render scheduler is temporarily idle.
  for (let i = 0; i < 100; i++) {
    await ui.flush();
    const frame = ui.captureCharFrame();
    if (frame.includes(text)) return frame;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Missing ${text} in frame:\n${ui.captureCharFrame()}`);
}
try {
  send({ type: 'run_started', run: { id: 'r', status: 'running', startedAt: 0 } });
  send({ type: 'text_delta', messageId: 'reply', text: '中文测试 **bold**\n\n```ts\nconst answer = ' });
  app.flush(); await ui.flush();
  let frame = await frameContaining('const answer');
  assert.match(frame, /中文测试/); assert.match(frame, /const answer/);
  send({ type: 'text_delta', messageId: 'reply', text: '42;\n```\n\nDone.' });
  c.messages.push(new AIMessage({ id: 'reply', content: '中文测试 **bold**\n\n```ts\nconst answer = 42;\n```\n\nDone.' }));
  send({ type: 'session_updated', context: c });
  send({ type: 'run_finished', run: { id: 'r', status: 'completed', startedAt: 0 } });
  app.flush(); await ui.flush(); frame = ui.captureCharFrame();
  assert.equal(frame.split('中文测试').length - 1, 1); assert.match(frame, /Done\./);
  themeManager.setTheme('dracula'); await ui.flush(); assert.match(ui.captureCharFrame(), /Done\./);
  ui.resize(40, 18); app.flush(); await ui.flush(); assert.match(ui.captureCharFrame(), /Enter send/);
  app.input.setText('/he'); ui.mockInput.pressTab(); assert.equal(app.input.plainText, '/help ');
  app.input.setText(''); await ui.mockInput.pasteBracketedText('第一行\n第二行');
  assert.equal(app.input.plainText, '第一行\n第二行');
  app.input.setText('draft'); ui.mockInput.pressKey('j', { ctrl: true }); assert.match(app.input.plainText, /\n/);
  app.input.setText('/clear'); await app.submit(); await ui.flush(); assert.ok(!ui.captureCharFrame().includes('const answer'));
  app.input.setText('hello'); await app.submit();
  app.input.setText(''); ui.mockInput.pressArrow('up'); assert.equal(app.input.plainText, 'hello');
  for (let i = 0; i < 35; i++) c.messages.push(new AIMessage({ id: `long-${i}`, content: `History line ${i}` }));
  send({ type: 'session_updated', context: c }); app.flush(); await ui.flush();
  assert.ok(app.scroll.scrollHeight > app.scroll.height);
  app.scroll.scrollTo(0); await ui.flush(); assert.match(ui.captureCharFrame(), /History line 0/);
  fake.activeRunId = 'active'; ui.mockInput.pressEscape(); await Promise.resolve(); assert.equal(cancelled, 1);
  ui.mockInput.pressCtrlC(); await Promise.resolve(); await Promise.resolve();
  assert.equal(closed, 1); assert.equal(exited, 1);
  console.log('OpenTUI native checks passed: streaming, completion, CJK, resize, themes, paste, history, scrolling, cancellation, exit.');
} finally { app.dispose(); ui.renderer.destroy(); themeManager.setTheme('ayu-dark'); }
