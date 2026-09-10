# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Deer-code is an AI coding agent project that provides a minimalist yet sufficient framework for developing AI-powered coding assistants. It uses LangChain and LangGraph for agent orchestration and supports MCP (Model Context Protocol) for extensible tool integration.

## Development Commands

```bash
# Install dependencies (uses pnpm)
pnpm install

# Development mode - run the agent directly with tsx
pnpm dev

# Build the project
pnpm build

# Run type checking
pnpm typecheck

# Run linting
pnpm lint

# Start the built application
pnpm start
```

## Architecture Overview

### Core Components

1. **Agent System** (`src/agents/`)
   - `CodingAgent`: Main agent class that orchestrates AI interactions
   - Uses LangChain's ReactAgent pattern with LangGraph
   - Manages context compression and token limits

2. **Tool System** (`src/tools/`)
   - Built-in tools: bash, grep, ls, tree, text editor, todo management
   - Tools are LangChain-compatible and follow consistent patterns
   - Each tool has its own directory with implementation and tests

3. **MCP Integration** (`src/mcp/`)
   - Supports external MCP servers via stdio and HTTP transports
   - Automatically converts MCP tools to LangChain format
   - Tools are prefixed with `mcp_{server_name}_{tool_name}`

4. **Session Management** (`src/session/`)
   - Persistent session storage and management
   - Commands: start, list, switch, delete, info

5. **Context Management** (`src/context/`)
   - Token counting and context compression
   - Automatic summarization when approaching token limits

### Skills

- `src/skills/` discovers user and project `.deer-code/skills/*/SKILL.md` packages; project names override user names.
- `load_skill`, `read_skill_resource`, and `unload_skill` provide on-demand instructions and bounded relative text-resource reads. Loading never runs scripts.
- `createSkillMiddleware` rebuilds active instructions before each model request and includes them in context budgeting. Persist only skill path/hash references in sessions; changed files deactivate until reloaded.
- `pnpm test` runs offline skill and graph integration tests. `deer-code skills [name]` inspects skills without model credentials. See `docs/SKILLS.md` for usage and `pnpm skills:preview` for local inspection.

### Configuration

Subagent implementation lives in `src/agents/subagents/`. `AgentManager` owns lifecycle, inboxes, concurrency (two read-only children) and per-root JSONL journals. Only the root gets delegation tools. Children get no shell, editor, Todo, MCP or spawn tools. `CodingAgent.cleanup()` releases only its owned resources; application shutdown owns MCP disconnection. Shell tools are per-agent factories, and cancellation is propagated to the model and async search. See `docs/SUBAGENTS.md`, `pnpm test`, and `pnpm subagents:preview`.

Configuration is managed through `config.yaml`:
- Model settings (API keys, base URLs, parameters)
- MCP server configurations
- Context management settings

### Key Patterns

- All imports use `.js` extension (ESM requirement)
- Tools follow a standard interface with `name`, `description`, and `schema`
- Error handling includes user-friendly messages
- Git hooks enforce commit message format and type checking

## Important Notes

- The project uses ES modules (`"type": "module"` in package.json)
- TypeScript compilation targets ES2022
- React is used for terminal UI components (Ink framework)
- All file operations should respect the project root directory from `project.rootDir`
- MCP servers are initialized at startup and disconnected on cleanup
