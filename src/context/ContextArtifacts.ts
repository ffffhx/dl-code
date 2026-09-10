import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

/** Content-addressed, session-scoped files. Writing the same result is idempotent. */
export class ContextArtifacts {
  readonly directory: string;

  constructor(sessionId: string, root = path.join(os.homedir(), '.deer-code', 'context')) {
    this.directory = path.join(root, createHash('sha256').update(sessionId).digest('hex'));
  }

  write(kind: 'output' | 'history', text: string): string {
    const id = `${kind}-${createHash('sha256').update(text).digest('hex')}.txt`;
    fs.mkdirSync(this.directory, { recursive: true });
    const file = path.join(this.directory, id);
    try {
      fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || fs.readFileSync(file, 'utf8') !== text) {
        throw new Error('Existing context artifact is invalid or corrupted: ' + id);
      }
    }
    return id;
  }

  read(id: string, offset = 0, limit = 4000) {
    if (!/^(output|history)-[a-f0-9]{64}\.txt$/.test(id)) throw new Error('Invalid context artifact ID');
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 4000) {
      throw new Error('Invalid offset or limit');
    }
    const file = path.join(this.directory, id);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Context artifact must not be a symbolic link');
    const text = fs.readFileSync(file, 'utf8');
    const end = Math.min(offset + limit, text.length);
    return { id, offset, totalCharacters: text.length, nextOffset: end < text.length ? end : null, content: text.slice(offset, end) };
  }

  tool(maxCharacters = 4000) {
    return new DynamicStructuredTool({
      name: 'read_context_artifact',
      description: 'Read original tool output or archived conversation by artifact ID. Offsets and limits are characters. Follow nextOffset for more; files are scoped to this session.',
      schema: z.object({
        id: z.string(),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(4000).default(2000),
      }),
      func: async ({ id, offset, limit }) => {
        try { return JSON.stringify(this.read(id, offset, Math.min(limit, maxCharacters))); }
        catch (error) { return `Context artifact error: ${(error as Error).message}`; }
      },
    });
  }
}
