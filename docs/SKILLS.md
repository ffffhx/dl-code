# Skills

Deer-code discovers local SKILL.md packages and gives the model a metadata-only catalog. Full instructions enter the context only after `load_skill` is called. Loading a skill never executes its scripts.

## Install a skill

Create one directory per skill in either location:

- User: `~/.deer-code/skills/<folder>/SKILL.md`
- Project: `<project>/.deer-code/skills/<folder>/SKILL.md`

Project skills override user skills with the same `name`. Discovery refreshes at the beginning of every user turn. Duplicate names within a scope use the first valid directory in sorted order and report a warning; malformed files are skipped. User-managed skill-directory symlinks are supported.

Example SKILL.md:

```markdown
---
name: react-review
description: Review React components for state design, side effects and rendering performance.
---

Read the component and its callers before proposing changes.
Read references/checklist.md when detailed review rules are needed.
Report findings with file locations and distinguish verified behavior from hypotheses.
```

Names use lowercase letters, digits and single hyphens (max 64 characters). Descriptions are nonempty and at most 1024 characters. Each instruction or resource file must be text and at most 128 KiB.

## Use and inspect

Ask the agent: “Use react-review to review this component.” The prompt tells the model to load explicitly requested or clearly applicable skills. Automatic selection is model-driven, not a deterministic keyword matcher.

```bash
pnpm exec tsx src/main.ts skills
pnpm exec tsx src/main.ts skills react-review --dir /path/to/project
pnpm exec tsx src/main.ts skills react-review --resource references/checklist.md
```

These inspection commands do not require model credentials or modify sessions.

The agent receives three tools:

- `load_skill({name})`: read instructions and activate the skill for the current session.
- `read_skill_resource({name, path})`: read a referenced text file relative to an active skill directory. Absolute paths, traversal and symlinks escaping that directory are rejected.
- `unload_skill({name})`: stop reinjecting a skill when no longer relevant. Existing conversation history remains.

Skill files are guidance under the existing user instructions and tool permissions. Script execution requires an explicit call to an existing execution tool. This feature does not add a sandbox to existing file or terminal tools.

## Context and persistence

Active skills are saved as name, canonical entry path and SHA-256 hash in the session JSON. Every model request re-reads active files and adds their instructions to a fresh system message, including requests immediately after a tool call. History compression therefore does not discard active rules. The system prompt, active skill text, tool arguments and tool schemas count toward the local input estimate; output tokens and a safety margin are reserved separately. Provider-specific overhead and multimedia counts are approximate. See [Token management](TOKEN_MANAGEMENT.md) for context configuration, persistent incremental summaries and original-output retrieval.

Changed, missing or shadowed skills are deactivated with a notice and must be loaded again. Resuming under a different project cannot silently substitute that project's same-named skill. Clearing chat clears active skill references. Skill state is saved as it changes, including if a later model request fails. Resource text stays in ordinary history and can be read again when needed.

If compression cannot bring the estimated input under the configured limit, the request fails visibly rather than silently truncating active instructions. Start a new session or reduce the active skill set. Loading does not guarantee the model will follow instructions; verify outcomes against the task requirements.

## Local preview and tests

```bash
pnpm test
pnpm skills:preview
```

The preview starts a read-only text inspection service at http://127.0.0.1:4322. `/skills` lists metadata, `/skills/<name>` shows instructions, and `?resource=references/checklist.md` reads a resource. It never calls a model or changes active sessions. Pass a project path after the command to inspect that project's skills.
