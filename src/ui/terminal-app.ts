import {
  BoxRenderable, MarkdownRenderable, ScrollBoxRenderable, SyntaxStyle,
  TextRenderable, TextareaRenderable, type CliRenderer, type KeyEvent,
} from '@opentui/core';
import type { AgentSession } from '../runtime/index.js';
import type { SessionContext } from '../session/types.js';
import { project } from '../project.js';
import { themeManager } from './themes/ThemeManager.js';
import { executeSlashCommand, getCommandSuggestions, isSlashCommand } from './slash-commands/commands.js';
import { terminalText, Transcript, type TranscriptEntry } from './transcript.js';

interface MessageView {
  box: BoxRenderable;
  label: TextRenderable;
  body: TextRenderable | MarkdownRenderable;
}

/** OpenTUI owns terminal output; the session owns execution and durable history. */
export class TerminalApp {
  readonly transcript = new Transcript();
  readonly root: BoxRenderable;
  readonly scroll: ScrollBoxRenderable;
  readonly input: TextareaRenderable;
  private readonly header: TextRenderable;
  private readonly status: TextRenderable;
  private readonly hint: TextRenderable;
  private readonly todos: TextRenderable;
  private readonly composer: BoxRenderable;
  private readonly views = new Map<string, MessageView>();
  private context: SessionContext;
  private syntax: SyntaxStyle;
  private unsubscribe: () => void;
  private unsubscribeTheme: () => void;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private closing?: Promise<void>;
  private submitting = false;
  private showTodos = true;
  private disposed = false;
  private inputHistory: string[] = [];
  private historyIndex = 0;
  private draft = '';

  constructor(private renderer: CliRenderer, private session: AgentSession, private onExit: () => void) {
    this.context = session.snapshot();
    this.transcript.sync(this.context);
    this.syntax = this.createSyntax();
    const c = themeManager.getTheme().colors;
    this.root = new BoxRenderable(renderer, { id: 'dl-code', width: '100%', height: '100%',
      flexDirection: 'column', backgroundColor: c.background.primary });
    this.header = new TextRenderable(renderer, { id: 'header', height: 2, flexShrink: 0, fg: c.accent });
    this.scroll = new ScrollBoxRenderable(renderer, { id: 'conversation', flexGrow: 1, flexShrink: 1,
      minHeight: 1, scrollX: false, scrollY: true, stickyScroll: true, stickyStart: 'bottom',
      viewportCulling: true, contentOptions: { flexDirection: 'column', paddingX: 1, gap: 1 } });
    this.todos = new TextRenderable(renderer, { id: 'todos', flexShrink: 0, maxHeight: 5, fg: c.text.secondary });
    this.status = new TextRenderable(renderer, { id: 'status', height: 1, flexShrink: 0, fg: c.warning });
    this.composer = new BoxRenderable(renderer, { id: 'composer', border: true, borderStyle: 'rounded',
      borderColor: c.accent, paddingX: 1, flexShrink: 0, height: 5 });
    this.input = new TextareaRenderable(renderer, { id: 'prompt', width: '100%', height: 3,
      placeholder: 'Ask dl-code to work on this project…', textColor: c.text.primary,
      backgroundColor: c.background.secondary, focusedBackgroundColor: c.background.secondary,
      cursorColor: c.accent, wrapMode: 'word',
      keyBindings: [{ name: 'return', action: 'submit' }, { name: 'return', shift: true, action: 'newline' },
        { name: 'return', ctrl: true, action: 'newline' }, { name: 'j', ctrl: true, action: 'newline' }],
      onSubmit: () => { void this.submit().catch(error => this.error(error)); },
    });
    this.hint = new TextRenderable(renderer, { id: 'keys', height: 1, flexShrink: 0, fg: c.text.secondary });
    this.composer.add(this.input);
    for (const node of [this.header, this.scroll, this.todos, this.status, this.composer, this.hint]) this.root.add(node);
    renderer.root.add(this.root);
    this.input.focus();
    renderer.keyInput.on('keypress', this.onKey);
    this.unsubscribe = session.subscribe(event => {
      if (event.type === 'session_updated') this.context = event.context;
      this.transcript.apply(event);
      this.schedule();
    });
    this.unsubscribeTheme = themeManager.subscribe(() => this.applyTheme());
    this.flush();
  }

  private createSyntax(): SyntaxStyle {
    const c = themeManager.getTheme().colors;
    return SyntaxStyle.fromStyles({
      default: { fg: c.text.primary }, 'markup.heading': { fg: c.accent, bold: true },
      'markup.heading.1': { fg: c.accent, bold: true }, 'markup.heading.2': { fg: c.accent, bold: true },
      'markup.strong': { fg: c.text.primary, bold: true }, 'markup.italic': { italic: true },
      'markup.raw': { fg: c.syntax.string }, 'markup.link': { fg: c.accent, underline: true },
      'markup.list': { fg: c.warning }, keyword: { fg: c.syntax.keyword }, string: { fg: c.syntax.string },
      comment: { fg: c.syntax.comment, italic: true }, number: { fg: c.syntax.number },
      function: { fg: c.syntax.function }, type: { fg: c.syntax.type },
    });
  }

  private applyTheme(): void {
    const old = this.syntax;
    this.syntax = this.createSyntax();
    const c = themeManager.getTheme().colors;
    this.root.backgroundColor = c.background.primary;
    this.header.fg = c.accent;
    this.composer.borderColor = c.accent;
    this.status.fg = c.warning;
    this.hint.fg = c.text.secondary;
    this.todos.fg = c.text.secondary;
    this.input.textColor = c.text.primary;
    this.input.focusedTextColor = c.text.primary;
    this.input.backgroundColor = c.background.secondary;
    this.input.focusedBackgroundColor = c.background.secondary;
    for (const view of this.views.values()) {
      view.body.fg = c.text.primary;
      if (view.body instanceof MarkdownRenderable) view.body.syntaxStyle = this.syntax;
    }
    this.flush();
    old.destroy();
  }

  private schedule(): void {
    if (!this.flushTimer && !this.disposed) this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, 33);
  }

  flush(): void {
    if (this.disposed) return;
    const wanted = new Set(this.transcript.entries.map(entry => entry.id));
    for (const [id, view] of this.views) if (!wanted.has(id)) {
      this.scroll.remove(view.box);
      view.box.destroyRecursively();
      this.views.delete(id);
    }
    this.transcript.entries.forEach((entry, index) => this.renderEntry(entry, index));
    const c = this.context;
    this.header.content = ` DL-CODE  /  ${terminalText(c.userName || 'workspace')}\n ${terminalText(project.rootDir)}`;
    this.status.content = ` ${this.transcript.status}${c.tokenUsage ? `  ·  context ${c.tokenUsage.totalTokens} tokens` : ''}`;
    this.todos.visible = this.showTodos && c.todos.length > 0;
    this.todos.content = c.todos.slice(0, 4).map(todo =>
      ` ${todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '›' : '·'} ${terminalText(todo.content)}`).join('\n');
    this.hint.content = this.renderer.width < 100
      ? ' Enter send · Ctrl+J newline · /help'
      : ' Enter send  ·  Shift+Enter / Ctrl+J newline  ·  Esc stop  ·  PgUp/PgDn scroll  ·  Ctrl+C exit';
  }

  private renderEntry(entry: TranscriptEntry, index: number): void {
    const c = themeManager.getTheme().colors;
    let view = this.views.get(entry.id);
    if (!view) {
      const box = new BoxRenderable(this.renderer, { id: `row-${entry.id}`, flexDirection: 'column', flexShrink: 0, width: '100%' });
      const label = new TextRenderable(this.renderer, { id: `label-${entry.id}`, height: 1 });
      const body = entry.role === 'assistant'
        ? new MarkdownRenderable(this.renderer, { id: `body-${entry.id}`, content: '', syntaxStyle: this.syntax,
          width: '100%', streaming: !!entry.streaming, conceal: true, fg: c.text.primary,
          tableOptions: { widthMode: 'full', wrapMode: 'word' } })
        : new TextRenderable(this.renderer, { id: `body-${entry.id}`, content: '', width: '100%', wrapMode: 'word', fg: c.text.primary });
      box.add(label); box.add(body);
      this.scroll.add(box, index);
      view = { box, label, body };
      this.views.set(entry.id, view);
    }
    view.label.content = entry.role === 'tool'
      ? `${entry.failed ? '✗' : entry.streaming ? '›' : '✓'} ${entry.label}`
      : entry.label ?? (entry.role === 'user' ? 'You' : entry.role === 'assistant' ? 'dl-code' : 'Notice');
    view.label.fg = entry.failed ? c.error : entry.role === 'user' ? c.accent : c.success;
    const text = terminalText(entry.text);
    if (view.body.content !== text) view.body.content = text;
    if (view.body instanceof MarkdownRenderable) view.body.streaming = !!entry.streaming;
  }

  private onKey = (key: KeyEvent): void => {
    if (key.ctrl && key.name === 'c') { key.preventDefault(); void this.close().catch(() => { process.exitCode = 1; }); }
    else if (key.name === 'escape' && this.session.activeRunId) {
      key.preventDefault();
      void this.session.cancel(this.session.activeRunId).catch(error => this.error(error));
    } else if (key.name === 'pageup' || key.name === 'pagedown') {
      key.preventDefault(); this.scroll.scrollBy(key.name === 'pageup' ? -1 : 1, 'viewport');
    } else if (key.ctrl && key.name === 'end') {
      key.preventDefault(); this.scroll.scrollTo(this.scroll.scrollHeight);
    } else if (key.name === 'tab') {
      const suggestions = getCommandSuggestions(this.input.plainText);
      if (suggestions.length) {
        key.preventDefault(); this.input.setText(suggestions[0] + ' ');
        this.input.gotoBufferEnd();
      }
    } else if ((key.name === 'up' || key.name === 'down') && !this.input.plainText.includes('\n') && this.inputHistory.length) {
      key.preventDefault();
      if (this.historyIndex === this.inputHistory.length) this.draft = this.input.plainText;
      this.historyIndex = Math.max(0, Math.min(this.inputHistory.length, this.historyIndex + (key.name === 'up' ? -1 : 1)));
      this.input.setText(this.inputHistory[this.historyIndex] ?? this.draft);
      this.input.gotoBufferEnd();
    }
  };

  async submit(): Promise<void> {
    const text = this.input.plainText.trim();
    if (!text || this.submitting || this.closing) return;
    if (['q', 'exit', 'quit', '/exit', '/quit', '/q'].includes(text)) { await this.close(); return; }
    if (this.session.activeRunId) { this.transcript.status = 'Working · Esc to stop; your draft is kept'; this.flush(); return; }
    this.submitting = true;
    this.input.setText('');
    this.inputHistory.push(text); this.historyIndex = this.inputHistory.length; this.draft = '';
    try {
      if (isSlashCommand(text)) {
        const result = executeSlashCommand(text, {
          clearMessages: () => { this.session.clear(); this.transcript.clear(); },
          toggleTodoPanel: () => { this.showTodos = !this.showTodos; },
          setTheme: name => { themeManager.setTheme(name); },
          exitApp: () => { void this.close(); },
        });
        if (result.message) this.transcript.notice(result.message, !result.success);
        if (result.action === 'exit') { await this.close(); return; }
        if (result.action === 'resume') {
          const run = this.session.snapshot().lastRun;
          if (!run) throw new Error('No interrupted run to resume');
          for await (const event of this.session.resume(run.id)) void event;
        }
      } else for await (const event of this.session.run({ text })) void event;
    } catch (error) { this.error(error); }
    finally { this.submitting = false; this.flush(); }
  }

  private error(error: unknown): void {
    this.transcript.notice(error instanceof Error ? error.message : String(error), true);
    this.schedule();
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      try { await this.session.shutdown(); }
      finally { this.dispose(); this.onExit(); }
    })();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.flushTimer);
    this.unsubscribe(); this.unsubscribeTheme();
    this.renderer.keyInput.off('keypress', this.onKey);
    this.renderer.root.remove(this.root);
    this.root.destroyRecursively();
    this.syntax.destroy();
  }
}
