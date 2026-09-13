import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { minimatch } from 'minimatch';
import { DEFAULT_IGNORE_PATTERNS } from './ignore.js';

export const lsTool = new DynamicStructuredTool({
  name: 'ls',
  description: 'Lists files and directories in a given path. Optionally provide an array of glob patterns to match and ignore.',
  schema: z.object({
    path: z.string().describe('The absolute path to list files and directories from. Relative paths are **not** allowed.'),
    match: z.array(z.string()).optional().nullable().describe('An optional array of glob patterns to match.'),
    ignore: z.array(z.string()).optional().nullable().describe('An optional array of glob patterns to ignore.'),
  }),
  func: async ({ path: targetPath, match, ignore }: { path: string; match?: string[]; ignore?: string[] }) => {
    const resolvedPath = path.resolve(targetPath);
    
    if (!path.isAbsolute(targetPath)) {
      return `Error: the path ${targetPath} is not an absolute path. Please provide an absolute path.`;
    }
    
    if (!fs.existsSync(resolvedPath)) {
      return `Error: the path ${targetPath} does not exist. Please provide a valid path.`;
    }
    
    if (!fs.statSync(resolvedPath).isDirectory()) {
      return `Error: the path ${targetPath} is not a directory. Please provide a valid directory path.`;
    }
    
    try {
      let items = fs.readdirSync(resolvedPath).map((name) => {
        const fullPath = path.join(resolvedPath, name);
        const isFile = fs.statSync(fullPath).isFile();
        return { name, isFile };
      });
      
      items.sort((a, b) => {
        if (a.isFile && !b.isFile) return 1;
        if (!a.isFile && b.isFile) return -1;
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });
      
      if (match) {
        items = items.filter((item) => {
          return match.some((pattern) => minimatch(item.name, pattern));
        });
      }
      
      const ignorePatterns = [...(ignore || []), ...DEFAULT_IGNORE_PATTERNS];
      items = items.filter((item) => {
        return !ignorePatterns.some((pattern) => minimatch(item.name, pattern));
      });
      
      if (items.length === 0) {
        return `No items found in ${targetPath}.`;
      }
      
      const resultLines = items.map((item) => {
        return item.isFile ? item.name : item.name + '/';
      });
      
      return `Here's the result in ${targetPath}: \n\`\`\`\n${resultLines.join('\n')}\n\`\`\``;
    } catch {
      return `Error: permission denied to access the path ${targetPath}.`;
    }
  },
});
