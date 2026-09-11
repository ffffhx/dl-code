import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import React from 'react';
import { render, Text } from 'ink';
import { marked } from 'marked';
import { App } from '../src/ui/App.js';
import { MessageArea } from '../src/ui/components/MessageArea.js';
import { MarkdownRenderer } from '../src/ui/components/MarkdownRenderer.js';
import { themeManager, useTheme } from '../src/ui/themes/index.js';
import { useAppStore } from '../src/store/app-store.js';
import type { HarnessRuntime } from '../src/harness/index.js';

function mount(t: TestContext, element: React.ReactElement, columns = 80) {
  const stdout = Object.assign(new PassThrough(), { columns, rows: 24 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const frames: string[] = [];
  stdout.on('data', data => frames.push(data.toString()));
  const view = render(element, { stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  t.after(() => { view.unmount(); view.cleanup(); });
  return { stdout, frame: () => frames.at(-1) ?? '' };
}

test('streaming text is visible and replaced by one completed reply', async t => {
  const store = useAppStore.getState();
  store.clearMessages();
  store.setIsProcessing(true);
  store.startStreaming('reply');
  store.updateStreamingBuffer('Partial response');
  const ui = mount(t, React.createElement(MessageArea));
  await delay(30);
  assert.match(ui.frame(), /Partial response/);
  store.endStreaming();
  store.setIsProcessing(false);
  await delay(30);
  assert.equal(ui.frame().split('Partial response').length - 1, 1);
});

test('clear removes stale activity and messages have unique keys at the same time', t => {
  const store = useAppStore.getState();
  store.clearMessages();
  t.mock.method(Date, 'now', () => 12345);
  store.addSystemMessage('First');
  store.addSystemMessage('Second');
  assert.equal(new Set(useAppStore.getState().session.displayMessages.map(m => m.id)).size, 2);
  store.addThinkingStep({ type: 'reasoning', timestamp: 1, content: 'Old work' });
  store.startStreaming('old');
  store.updateStreamingBuffer('Old text');
  store.clearMessages();
  const session = useAppStore.getState().session;
  assert.deepEqual(session.thinkingSteps, []);
  assert.equal(session.currentStreamingBuffer, '');
  assert.equal(session.currentStreamingMessageId, null);
});

test('theme subscribers refresh without another store update', async t => {
  function ThemeLabel() { return React.createElement(Text, null, useTheme().name); }
  themeManager.setTheme('ayu-dark');
  t.after(() => { themeManager.setTheme('ayu-dark'); });
  const ui = mount(t, React.createElement(ThemeLabel));
  await delay(30);
  themeManager.setTheme('dracula');
  await delay(30);
  assert.match(ui.frame(), /dracula/);
});

test('Markdown uses available columns and does not mutate the global parser', async t => {
  const original = marked.parse('**bold**');
  useAppStore.getState().setTerminalSize(30, 24);
  const ui = mount(t, React.createElement(MarkdownRenderer, { content: 'alpha beta gamma delta epsilon zeta eta theta iota kappa' }), 120);
  await delay(30);
  assert.ok(ui.frame().split('\n').every(line => line.length <= 28), ui.frame());
  useAppStore.getState().setTerminalSize(100, 24);
  await delay(30);
  assert.match(ui.frame(), /alpha beta gamma delta epsilon zeta/);
  assert.equal(marked.parse('**bold**'), original);
});

test('App follows output resize and keeps loading visible after a tool result', async t => {
  const store = useAppStore.getState();
  store.clearMessages();
  store.setIsProcessing(true);
  store.addThinkingStep({ type: 'tool_result', timestamp: 1, result: 'Done', content: 'Done' });
  const harness = { snapshot: () => store.getSessionContext(), subscribe: () => () => {},
    shutdown: async () => {} } as unknown as HarnessRuntime;
  const ui = mount(t, React.createElement(App, { harness }), 60);
  await delay(30);
  assert.equal(useAppStore.getState().ui.terminalWidth, 60);
  assert.match(ui.frame(), /Thinking\.\.\./);
  ui.stdout.columns = 40;
  ui.stdout.emit('resize');
  await delay(30);
  assert.equal(useAppStore.getState().ui.terminalWidth, 40);
  assert.match(ui.frame(), /Processing\.\.\./);
  store.setIsProcessing(false);
});
