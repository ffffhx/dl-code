# OpenTUI terminal UI

dl-code uses `@opentui/core` for its interactive terminal. The UI uses Core renderables directly; it does not mount an Ink or browser React tree. Agent execution, MCP, sessions, Skills and context compression remain in the AgentSession layer.

## Run

```powershell
npm install
npm run build
npm start
```

For source development: `npm run dev`. Bun is a pinned local dependency, so a global Bun installation is not required. OpenTUI 0.5.11 requires Bun >=1.3 or Node >=26.4 with experimental FFI; the supplied scripts use Bun, including on Windows with Node 22 installed. Do not run `node dist/main.js` with Node 22.

From another directory:

```powershell
npm --prefix "C:\path\to\dl-code" start -- "D:\project-to-work-on"
```

The current working directory still supplies `config.yaml` and `.env`; `npm --prefix` selects the dl-code installation directory, and the positional argument selects the working project. The package's `dl-code` executable uses a Node launcher to locate the bundled Bun runtime. It preserves the caller's working directory and therefore expects configuration there when invoked directly.

## Interaction

- Enter: send. Shift+Enter, Ctrl+Enter or Ctrl+J: newline (Ctrl+J works when a terminal cannot distinguish Shift+Enter).
- Mouse wheel / Page Up / Page Down: browse history. Ctrl+End: return to the bottom and resume following output.
- Up / Down in a single-line input: browse submitted prompts. Multiline input uses normal cursor navigation.
- Tab: complete a slash command. `/help`, `/clear`, `/todo`, `/theme`, `/resume`, `/exit` remain available.
- Escape: cancel a run. Ctrl+C or `/exit`: cancel and release resources before restoring the terminal.
- Input can be drafted while a run is active; it is not automatically submitted as another request.

## Rendering and streaming

`CodingAgent` consumes LangGraph `messages` and `updates` together. Text from the `model_request` node becomes transient `text_delta` AgentSession events with a message ID; internal summary calls are excluded. Completed updates still drive authoritative session persistence, tool calls and tool results. Partial text is never appended to durable model history.

`Transcript` projects completed history, pending text and tool outcomes. The completed message replaces its partial content by ID. Cancelled partial text is marked interrupted in the current UI; it is not restored as a complete model response after restart.

`TerminalApp` batches display updates at 33 ms, retains renderables by message ID, and passes `streaming` to OpenTUI's Markdown parser. Completed messages are not reparsed on every token. OpenTUI handles code highlighting, tables, Unicode cell widths, terminal resizing and viewport clipping. Tree-sitter highlighting finishes asynchronously; the first highlighted frame may follow the text frame.

Tool arguments and results use plain text, not Markdown. Each preview is limited to eight lines / 1,200 characters. Full results remain available to the agent through the existing session/artifact system. Unmatched tool calls at the end of a run display an unknown outcome, never success.

## Validation

- `npm test`: offline AgentSession, model stream, transcript, context, skills and subagent tests.
- `npm run test:ui`: native OpenTUI tests under Bun, including streaming code fences, CJK, duplicate prevention, resize, themes, paste, scrolling, cancellation and cleanup.
- `npm run build`: TypeScript build.

Native tests use synthetic input. IME candidate windows and keyboard modifier handling can vary between terminal hosts; Ctrl+J is the portable newline shortcut.
