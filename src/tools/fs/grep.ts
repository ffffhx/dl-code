import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { project } from '../../project.js';
const executeFile = promisify(execFile);
import { DEFAULT_IGNORE_PATTERNS } from './ignore.js';

export const grepTool = new DynamicStructuredTool({
  name: 'grep',
  description: `A powerful search tool built on ripgrep for searching file contents with regex patterns.
ALWAYS use this tool for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command.
Supports full regex syntax, file filtering, and various output modes.`,
  schema: z.object({
    pattern: z.string().describe('The regular expression pattern to search for in file contents. Uses ripgrep syntax - literal braces need escaping.'),
    path: z.string().optional().nullable().describe('File or directory to search in. Defaults to current working directory if not specified.'),
    glob: z.string().optional().nullable().describe('Glob pattern to filter files (e.g., "*.js", "*.{ts,tsx}").'),
    output_mode: z.enum(['content', 'files_with_matches', 'count']).nullable().default('files_with_matches').describe('Output mode - "content" shows matching lines, "files_with_matches" shows only file paths, "count" shows match counts.'),
    B: z.number().optional().nullable().describe('Number of lines to show before each match. Only works with output_mode="content".'),
    A: z.number().optional().nullable().describe('Number of lines to show after each match. Only works with output_mode="content".'),
    C: z.number().optional().nullable().describe('Number of lines to show before and after each match. Only works with output_mode="content".'),
    n: z.boolean().optional().nullable().describe('Show line numbers in output. Only works with output_mode="content".'),
    i: z.boolean().optional().nullable().describe('Enable case insensitive search.'),
    type: z.string().optional().nullable().describe('File type to search (e.g., "js", "py", "rust", "go", "java").'),
    head_limit: z.number().optional().nullable().describe('Limit output to first N lines/entries.'),
    multiline: z.boolean().nullable().default(false).describe('Enable multiline mode where patterns can span lines.'),
  }),
  func: async ({ pattern, path, glob, output_mode, B, A, C, n, i, type, head_limit, multiline }, _runManager, config) => {
    config?.signal?.throwIfAborted();
    const cmd: string[] = [];
    const searchPath = path ?? project.rootDir;
    
    const effectiveOutputMode = output_mode ?? 'files_with_matches';
    if (effectiveOutputMode === 'files_with_matches') {
      cmd.push('-l');
    } else if (effectiveOutputMode === 'count') {
      cmd.push('-c');
    }
    
    if (effectiveOutputMode === 'content') {
      if (C != null) {
        cmd.push('-C', String(C));
      } else {
        if (B != null) {
          cmd.push('-B', String(B));
        }
        if (A != null) {
          cmd.push('-A', String(A));
        }
      }
      if (n === true) {
        cmd.push('-n');
      }
    }
    
    if (i === true) {
      cmd.push('-i');
    }
    
    if (type != null) {
      cmd.push('--type', type);
    }
    
    if (glob != null) {
      cmd.push('--glob', glob);
    }
    
    for (const ignorePattern of DEFAULT_IGNORE_PATTERNS) {
      cmd.push('--glob', `!${ignorePattern}`);
    }
    
    if (multiline === true) {
      cmd.push('-U', '--multiline-dotall');
    }
    
    try {
      cmd.push('--', pattern, searchPath);
      let { stdout: output } = await executeFile('rg', cmd, {
        encoding: 'utf8', signal: config?.signal, timeout: 30000, maxBuffer: 2_000_000,
        cwd: project.rootDir, windowsHide: true,
      });
      
      if (head_limit && output) {
        const lines = output.split('\n');
        output = lines.slice(0, head_limit).join('\n');
      }
      
      if (output) {
        return `Here's the result in ${searchPath}:\n\n\`\`\`\n${output}\n\`\`\``;
      } else {
        return 'No matches found.';
      }
    } catch (error: any) {
      config?.signal?.throwIfAborted();
      if (error.code === 1) {
        return 'No matches found.';
      }
      return `Error: ${error.stderr || error.message}`;
    }
  },
});
