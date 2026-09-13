# dl-code

A learning-oriented coding agent built with TypeScript, LangChain / LangGraph and OpenTUI.

## Run

```sh
npm install
npm run build
npm start
# After linking or installing the package:
dl-code --help
```

The CLI launcher uses project-local Bun. Configuration comes from `config.yaml` and `.env` in the caller's working directory. See [terminal usage](docs/TERMINAL_UI.md).

## Agent runtime

`AgentSession` accepts input, saves conversation state, starts `CodingAgent`, forwards events, and handles cancellation and recovery. `CodingAgent` assembles tools and request middleware; LangChain / LangGraph runs the **Agent Loop** (model → tools → model). `SubagentManager` manages read-only children and their mailboxes, and currently also keeps the root record for shared journal recovery. `SessionManager` reads and writes session snapshots; it does not run agents.

See the [Agent Runtime and its four capabilities: compaction, memory, collaboration and tools](docs/ARCHITECTURE.md), [execution and recovery](docs/AGENT_RUNTIME.md), [context management](docs/TOKEN_MANAGEMENT.md), [Skills](docs/SKILLS.md), and [subagents](docs/SUBAGENTS.md).

Long-term memory uses inspectable Markdown entries in `<data-directory>/memory`, with user/project namespaces, lexical recall, source-file freshness checks, optimistic revisions and invalidation. Main agents can search/read/save/invalidate entries; read-only children can only search/read. MCP tools are discovered through `search_tools`, activated with `load_tools` and removed with `unload_tools`. Model and tool budgets are configurable under `runtime` in [config.example.yaml](config.example.yaml).

## Rename compatibility

The project and CLI are now named `dl-code`. New installations use `~/.dl-code`; project Skills use `<project>/.dl-code/skills`.

When `.dl-code` does not exist but `.deer-code` does, the application continues using that legacy directory in place, including sessions, journals, context artifacts, Skills and user rules. The same selection applies to project Skills. If both directories exist, `.dl-code` wins; they are not merged. Do not move a data directory while an agent is running. Existing Skill activation records contain absolute paths, so moving their files requires loading those Skills again.

Renaming the package does not rename an existing checkout directory or the GitHub repository. Historical copyright notices retain their original attribution.

## Verification

```sh
npm test
npm run test:ui
npm run build
```
