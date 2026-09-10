import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { minimatch } from 'minimatch';
import { DEFAULT_IGNORE_PATTERNS } from './ignore.js';

function shouldIgnore(filePath: string, ignorePatterns: string[]): boolean {
  const fileName = path.basename(filePath);
  
  for (const pattern of ignorePatterns) {
    const cleanPattern = pattern.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
    
    if (minimatch(fileName, cleanPattern) || minimatch(filePath, pattern)) {
      return true;
    }
  }
  
  return false;
}

function generateTree(
  directory: string,
  prefix: string = '',
  maxDepth: number | null = null,
  currentDepth: number = 0,
  ignorePatterns: string[] = []
): string[] {
  const lines: string[] = [];
  
  if (maxDepth !== null && currentDepth >= maxDepth) {
    return lines;
  }
  
  try {
    let entries = fs.readdirSync(directory).map((name) => {
      const fullPath = path.join(directory, name);
      const isDir = fs.statSync(fullPath).isDirectory();
      return { name, fullPath, isDir };
    });
    
    entries.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    
    entries = entries.filter((entry) => !shouldIgnore(entry.fullPath, ignorePatterns));
    
    entries.forEach((entry, index) => {
      const isLast = index === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const extension = isLast ? '    ' : '│   ';
      
      if (entry.isDir) {
        lines.push(`${prefix}${connector}${entry.name}/`);
        if (maxDepth === null || currentDepth + 1 < maxDepth) {
          const subLines = generateTree(
            entry.fullPath,
            prefix + extension,
            maxDepth,
            currentDepth + 1,
            ignorePatterns
          );
          lines.push(...subLines);
        }
      } else {
        lines.push(`${prefix}${connector}${entry.name}`);
      }
    });
  } catch {
    lines.push(`${prefix}[Permission Denied]`);
  }
  
  return lines;
}

export const treeTool = new DynamicStructuredTool({
  name: 'tree',
  description: `Display directory structure in a tree format, similar to the 'tree' command.
Shows files and directories in a hierarchical tree structure.
Automatically excludes common ignore patterns (version control, dependencies, build artifacts, etc.).`,
  schema: z.object({
    path: z.string().optional().nullable().describe('Directory path to display. Defaults to current working directory if not specified.'),
    max_depth: z.number().int().min(0).max(5).nullable().default(3).describe('Maximum depth to traverse, from 0 to 5. Defaults to 3.'),
  }),
  func: async ({ path: searchPath, max_depth }: { path?: string | null; max_depth?: number | null }) => {
    const targetPath = searchPath ?? '.';
    
    try {
      const resolvedPath = path.resolve(targetPath);
      
      if (!fs.existsSync(resolvedPath)) {
        return `Error: Path '${resolvedPath}' does not exist.`;
      }
      
      if (!fs.statSync(resolvedPath).isDirectory()) {
        return `Error: Path '${resolvedPath}' is not a directory.`;
      }
      
      const lines = [resolvedPath + '/'];
      const treeLines = generateTree(
        resolvedPath,
        '',
        max_depth ?? 3,
        0,
        DEFAULT_IGNORE_PATTERNS
      );
      lines.push(...treeLines);
      
      const dirCount = treeLines.filter((line) => line.trim().endsWith('/')).length;
      const fileCount = treeLines.length - dirCount;
      
      lines.push('');
      lines.push(`${dirCount} directories, ${fileCount} files`);
      
      const output = lines.join('\n');
      return `Here's the result in ${targetPath}:\n\n\`\`\`\n${output}\n\`\`\``;
    } catch (error) {
      return `Error: ${error}`;
    }
  },
});
