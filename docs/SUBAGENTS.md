# Subagents

dl-code runs the main agent and up to two read-only children in one Node.js process. Each child has independent messages, active skills, inbox, cancellation signal and status. Children receive only the explicit task/background, not the parent's full conversation. Children cannot spawn further children.

## Use

Start dl-code with your existing model configuration and ask:

“派两个子 Agent，分别检查项目入口和测试覆盖。你自己查看依赖，最后汇总两份结论。”

The main agent receives `spawn_agent`, `wait_agent`, `send_message`, `cancel_agent` and `list_agents` tools. Spawn returns an ID immediately; it does not wait for the child. The third simultaneous child is rejected until a slot opens. Wait timeout (up to 60 seconds) returns the current status and does not cancel the child.

`send_message` queues a message for a direct child. Before the next model request, the runtime drains its inbox, persists delivery and adds the messages to that request. Messages remain available for subsequent requests in that turn. If the message arrives after the child's last model call, the runtime starts another turn to deliver it. An explicit follow-up to a completed/failed/cancelled/interrupted child resumes that child's history. Child completion also queues a result notification for the parent; an idle parent reads it on its next request. `wait_agent` can retrieve results immediately.

The terminal UI shows the latest child status. Ctrl+C, `exit`, or `/exit` cancels children and closes owned resources. Child cancellation propagates to model requests (including summaries), checks before further tool calls, and aborts asynchronous searches. A cancelling child occupies its slot until its runner settles. Cancellation does not roll back completed operations.

## Read-only boundary and resource ownership

Children receive file reading, directory listing, bounded-depth tree inspection, ripgrep search, Skill tools and context-artifact reading. They receive no shell, editor, Todo, MCP or delegation tools. This is enforced by the tool list, even if a loaded Skill asks for those capabilities. File access uses the current user's permissions; this is not an OS sandbox or a secret-file filter.

Main-agent terminal tools are created per CodingAgent instance. Each lazily starts its own persistent non-interactive PowerShell/Bash process with separate cwd, environment and output buffers. Concurrent commands in the same shell return busy instead of mixing output. Commands have a 30-second timeout and 2 MB output cap. Close/cancel kills the owned process tree; interactive terminal programs are not supported. Independent shells still share the filesystem.

MCP connections belong to the application. CodingAgent cleanup closes only its own terminal/context resources; it never disconnects the global MCP manager. The application disconnects MCP once during shutdown. Children do not use MCP in this version, so unknown external side effects and shared server state are not exposed to parallel child tasks.

## Persistence and recovery

```text
~/.dl-code/agents/<root-session-id>/<agent-id>/
  metadata.json
  events.jsonl
```

Events are appended and flushed on creation, status changes, message enqueue/delivery and each completed model/tool output. Message additions are recorded incrementally; a history reset is explicit. Metadata is atomically replaced after the event append. The main session's existing JSON remains supported; the agent journal supplies the newer context on resume.

A per-root owner file prevents two live runtimes writing the same agent journal. Restarting after a dead owner recovers records, discards an incomplete final JSONL line and marks formerly running/cancelling tasks interrupted. Nothing restarts automatically. `send_message` explicitly continues an interrupted child, preserving its inbox and giving unanswered tool calls an interrupted result instead of replaying them. Completed results remain queryable. Parent and child logs contain local conversation/tool data just like normal session files.

```bash
pnpm exec tsx src/main.ts agents
pnpm exec tsx src/main.ts agents <root-session-id>
# Resume the selected main session with its child registry:
pnpm exec tsx src/main.ts switch <root-session-id>
pnpm exec tsx src/main.ts start --no-new
```

## Validation and preview

```bash
pnpm test
pnpm subagents:preview
```

http://127.0.0.1:4323/ serves this guide. `/agents` shows an offline demonstration using the real SubagentManager with deterministic runners: two tasks, one message delivery, one completion and one cancellation. `/events` shows their actual JSONL records. This demonstration makes no model API requests and does not modify user sessions. Tests additionally exercise real LangChain/CodingAgent tool loops with a scripted model and real isolated Shell processes.

Data-directory compatibility: `.dl-code` is preferred; if absent, an existing `.deer-code` directory is reused in place. See [rename compatibility](../README.md).
