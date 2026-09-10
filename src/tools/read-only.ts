import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import path from 'node:path';
import { TextEditor } from './edit/text-editor.js';
import { grepTool, lsTool, treeTool } from './fs/index.js';

export function createReadOnlyTools(projectRoot: string) {
  return [grepTool, lsTool, treeTool, new DynamicStructuredTool({
    name: 'read_file', description: 'Read a text file with line numbers. Relative paths resolve against the project root. This tool cannot modify files.',
    schema: z.object({ path: z.string(), start_line: z.number().int().positive().default(1), end_line: z.number().int().default(-1) }),
    func: async ({ path: file, start_line, end_line }) => {
      try { return new TextEditor().view(path.resolve(projectRoot, file), [start_line, end_line]); }
      catch (error) { return `Read error: ${String(error)}`; }
    },
  })];
}
