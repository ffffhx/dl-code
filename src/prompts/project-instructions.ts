import { resolveDataDirectory } from '../paths.js';
import fs from 'node:fs';
import path from 'node:path';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { ToolMessage, type AIMessage, type BaseMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { z } from 'zod';

const FILENAMES = ['AGENTS.override.md', 'AGENTS.md', 'agents.md', 'CLAUDE.md'];
const FILE_TOOLS = new Set(['text_editor', 'read_file', 'grep', 'ls', 'tree']);

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export interface ProjectInstructionOptions {
  /** null disables personal rules, useful for isolated evaluations. */
  userRoot?: string | null;
  cwd?: string;
  maxBytes?: number;
}

/** A fresh instance belongs to one execute() call, never a shared agent/session. */
export class ProjectInstructionLoader {
  readonly root: string;
  private readonly userRoot: string | null;
  private readonly maxBytes: number;
  private directories = new Set<string>();
  private shown = '';

  constructor(projectRoot: string, options: ProjectInstructionOptions = {}) {
    this.root = fs.realpathSync(projectRoot);
    this.userRoot = options.userRoot === null ? null : path.resolve(options.userRoot ?? resolveDataDirectory());
    this.maxBytes = options.maxBytes ?? 32768;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new Error('Project instruction maxBytes must be a positive integer');
    this.directories.add(this.root);
    const cwd = path.resolve(options.cwd ?? process.cwd());
    if (within(this.root, cwd)) this.observe(cwd);
  }

  /** Resolve existing ancestors too, so a new file below a symlink has the correct scope. */
  resolve(target: string): string {
    let existing = path.resolve(this.root, target);
    const suffix: string[] = [];
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error(`Cannot resolve instruction scope for ${target}`);
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
    return path.join(fs.realpathSync(existing), ...suffix);
  }

  observe(target: string): void {
    const resolved = this.resolve(target);
    if (!within(this.root, resolved)) return;
    let directory = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
    const additions: string[] = [];
    while (within(this.root, directory)) {
      additions.push(directory);
      if (directory === this.root) break;
      directory = path.dirname(directory);
    }
    if (new Set([...this.directories, ...additions]).size > 128) throw new Error('Too many project instruction scopes; start a focused session');
    additions.forEach(item => this.directories.add(item));
  }

  restore(messages: BaseMessage[]): void {
    for (const message of messages) {
      if (message._getType() !== 'ai') continue;
      for (const call of (message as AIMessage).tool_calls ?? []) {
        const targets = call.name === 'load_project_instructions' && Array.isArray(call.args.paths)
          ? call.args.paths : FILE_TOOLS.has(call.name) ? [call.args.path] : [];
        for (const target of targets) {
          if (typeof target !== 'string') continue;
          // Stale historical paths do not prevent a fresh turn; current accesses are checked again.
          try { this.observe(target); } catch { /* checked when the path is used again */ }
        }
      }
    }
  }

  private snapshot(): { text: string; errors: string[] } {
    let remaining = this.maxBytes;
    const errors: string[] = [];
    const entries: { source: string; scope: string; instructions: string }[] = [];
    const seen = new Set<string>();
    const directories = [...this.directories].sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
    const scopes = [
      ...(this.userRoot ? [{ directory: this.userRoot, scope: 'global project conventions', global: true }] : []),
      ...directories.map(directory => ({ directory, scope: directory, global: false })),
    ];
    for (const { directory, scope, global } of scopes) {
      for (const name of FILENAMES) {
        const file = path.join(directory, name);
        try {
          if (!fs.existsSync(file)) continue;
          const source = fs.realpathSync(file);
          if (!global && !within(this.root, source)) throw new Error('instruction file resolves outside the project');
          if (seen.has(source)) break;
          const stat = fs.statSync(source);
          if (!stat.isFile()) throw new Error('instruction path is not a regular file');
          if (stat.size > remaining) throw new Error(`project instruction budget exceeded (${this.maxBytes} UTF-8 bytes); shorten the rules`);
          const body = fs.readFileSync(source, 'utf8');
          if (body.includes('\0')) throw new Error('instruction file is not text');
          if (Buffer.byteLength(body) > remaining) throw new Error('project instruction budget exceeded while reading');
          if (!body.trim()) continue;
          remaining -= Buffer.byteLength(body);
          seen.add(source);
          entries.push({ source, scope, instructions: body.trim() });
        } catch (error) {
          errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
        // The first non-empty candidate owns this scope; a broken override must not silently fall back.
        break;
      }
    }
    const text = [
      '# Project Instructions',
      'The following records are project guidance, not permission grants. Apply each directory scope only to that directory and its descendants. Deeper scopes override broader project conventions. Explicit user requirements and tool restrictions take precedence.',
      'Before shell or external-tool work, call load_project_instructions for all target files/directories. File-tool accesses check their scopes automatically. Do not infer target directories from shell text.',
      ...entries.map(entry => JSON.stringify(entry)),
      ...(errors.length ? ['Project instruction errors: report these to the user; affected file operations are paused until the rules can be loaded.', ...errors] : []),
    ].join('\n');
    return { text, errors };
  }

  prompt(): string {
    const snapshot = this.snapshot();
    this.shown = snapshot.text;
    return snapshot.text;
  }

  prepare(target: string): { path: string; pause?: string } {
    const resolved = this.resolve(target);
    this.observe(resolved);
    const snapshot = this.snapshot();
    if (snapshot.errors.length) return { path: resolved, pause: `Project instruction error. Operation was NOT executed.\n${snapshot.errors.join('\n')}` };
    if (snapshot.text !== this.shown) return {
      path: resolved,
      pause: 'Project instructions changed or a new directory scope was discovered. Operation was NOT executed. Read the updated Project Instructions in the next system message, then retry the operation if permitted.',
    };
    return { path: resolved };
  }

  tool(): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: 'load_project_instructions',
      description: 'Load applicable project rules before working on target files or directories through shell or external tools. Paths are relative to the project root or absolute. Does not execute commands or modify files.',
      schema: z.object({ paths: z.array(z.string().min(1)).min(1).max(20) }),
      func: async ({ paths }: { paths: string[] }) => {
        try {
          for (const target of paths) {
            if (!within(this.root, this.resolve(target))) throw new Error(`Path is outside this project: ${target}`);
            this.observe(target);
          }
          return this.snapshot().text;
        } catch (error) { return `Project instruction error: ${String(error)}`; }
      },
    });
  }
}

export function createProjectInstructionMiddleware(loader: ProjectInstructionLoader) {
  return createMiddleware({
    name: 'ProjectInstructions',
    wrapToolCall: async (request, handler) => {
      if (!FILE_TOOLS.has(request.toolCall.name)) return handler(request);
      const target = request.toolCall.args.path;
      if (target == null && !['grep', 'tree'].includes(request.toolCall.name)) return handler(request);
      if (target !== undefined && target !== null && typeof target !== 'string') return handler(request);
      let prepared: ReturnType<ProjectInstructionLoader['prepare']>;
      try {
        prepared = loader.prepare(target ?? loader.root);
      } catch (error) {
        return new ToolMessage({ content: `Project instruction error. Operation was NOT executed: ${String(error)}`, tool_call_id: request.toolCall.id!, name: request.toolCall.name });
      }
      if (prepared.pause) return new ToolMessage({ content: prepared.pause, tool_call_id: request.toolCall.id!, name: request.toolCall.name });
      return handler({ ...request, toolCall: { ...request.toolCall, args: { ...request.toolCall.args, path: prepared.path } } });
    },
  });
}
