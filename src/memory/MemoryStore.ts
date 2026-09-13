import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import yaml from 'yaml';
import { z } from 'zod';
import { resolveDataDirectory } from '../paths.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const scopeSchema = z.enum(['project', 'user']);
export const memoryInput = z.object({
  scope: scopeSchema.default('project'),
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(6000),
  kind: z.enum(['fact', 'preference', 'experience']),
  evidence: z.enum(['verified', 'user_stated', 'hypothesis']),
  source: z.string().trim().min(1).max(1000),
  sourceFile: z.string().max(1000).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
  expiresAt: z.number().int().positive().optional(),
  expectedRevision: z.string().optional(),
});
export type MemoryInput = z.input<typeof memoryInput>;
export type MemoryScope = z.infer<typeof scopeSchema>;
const recordSchema = memoryInput.omit({ expectedRevision: true }).extend({
  createdAt: z.number(), updatedAt: z.number(), sourceHash: z.string().optional(),
  invalidated: z.string().optional(),
});
export type MemoryRecord = z.infer<typeof recordSchema> & { revision: string; stale: boolean };

/** Small, inspectable Markdown collection. No model-generated index is authoritative. */
export class MemoryStore {
  readonly projectRoot: string;
  readonly directory: string;
  readonly warnings: string[] = [];
  constructor(projectRoot: string, directory = path.join(resolveDataDirectory(), 'memory'), private now = Date.now) {
    this.projectRoot = fs.realpathSync(projectRoot);
    this.directory = path.resolve(directory);
  }

  private folder(scope: MemoryScope): string {
    const canonical = process.platform === 'win32' ? this.projectRoot.toLowerCase() : this.projectRoot;
    return path.join(this.directory, scope === 'user' ? 'user' : `project-${hash(canonical)}`);
  }

  private file(scope: MemoryScope, id: string): string {
    scopeSchema.parse(scope);
    memoryInput.shape.id.parse(id);
    const folder = this.folder(scope);
    // Reject links in the storage path before either reading or writing.
    for (let p = folder; ; p = path.dirname(p)) {
      if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error('Memory storage cannot contain symbolic links');
      if (path.dirname(p) === p) break;
    }
    const file = path.join(folder, `${id}.md`);
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Memory entry cannot be a symbolic link');
    return file;
  }

  private sourceHash(relative: string): string {
    const file = fs.realpathSync(path.resolve(this.projectRoot, relative));
    const rel = path.relative(this.projectRoot, file);
    if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) throw new Error('Memory source must be inside this project');
    if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('Memory source exceeds 2 MiB');
    return hash(fs.readFileSync(file, 'utf8'));
  }

  read(scope: MemoryScope, id: string): MemoryRecord {
    const file = this.file(scope, id);
    if (fs.statSync(file).size > 32768) throw new Error('Memory entry exceeds 32 KiB');
    const text = fs.readFileSync(file, 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
    if (!match) throw new Error(`Invalid memory Markdown: ${id}`);
    const record = recordSchema.parse({ ...yaml.parse(match[1]), content: match[2].trim() });
    if (record.scope !== scope || record.id !== id) throw new Error('Memory identity mismatch');
    let stale = !!record.invalidated || !!(record.expiresAt && record.expiresAt <= this.now());
    if (record.sourceFile) {
      try { stale ||= record.sourceHash !== this.sourceHash(record.sourceFile); } catch { stale = true; }
    }
    return { ...record, revision: hash(text), stale };
  }

  list(scope: MemoryScope): MemoryRecord[] {
    this.file(scope, 'index');
    const folder = this.folder(scope);
    if (!fs.existsSync(folder)) return [];
    const names = fs.readdirSync(folder).filter(name => /^[a-z0-9][a-z0-9_-]{0,79}\.md$/.test(name)).sort();
    if (names.length > 500) throw new Error('Memory collection exceeds 500 entries; consolidate it');
    const records: MemoryRecord[] = [];
    for (const name of names) {
      try { records.push(this.read(scope, name.slice(0, -3))); }
      catch (error) { this.warnings.push(`${scope}/${name}: ${String(error)}`); }
    }
    return records;
  }

  private write(scope: MemoryScope, id: string, expected: string | undefined, change: (old?: MemoryRecord) => z.infer<typeof recordSchema>): MemoryRecord {
    const file = this.file(scope, id);
    const folder = path.dirname(file);
    fs.mkdirSync(folder, { recursive: true });
    const lock = path.join(folder, '.write-lock');
    // Atomic per-namespace writer lease; recover only a provably dead process.
    if (fs.existsSync(lock)) {
      const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid memory lock');
      try { process.kill(owner.pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') fs.unlinkSync(lock);
      }
    }
    const token = randomUUID();
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
    const temp = path.join(folder, `.${token}.tmp`);
    try {
      const old = fs.existsSync(file) ? this.read(scope, id) : undefined;
      if (old ? old.revision !== expected : expected !== undefined) throw new Error('Memory revision conflict; read the entry and reconcile before updating');
      if (!old && this.list(scope).length >= 500) throw new Error('Memory collection is full');
      const record = recordSchema.parse(change(old));
      const { content, ...metadata } = record;
      fs.writeFileSync(temp, `---\n${yaml.stringify(metadata)}---\n${content}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
      return this.read(scope, id);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
      if (fs.existsSync(lock) && JSON.parse(fs.readFileSync(lock, 'utf8')).token === token) fs.unlinkSync(lock);
    }
  }

  upsert(input: MemoryInput): MemoryRecord {
    const parsed = memoryInput.parse(input);
    if (parsed.scope === 'user' && parsed.sourceFile) throw new Error('Project source files cannot be attached to user-wide memory');
    if (parsed.expiresAt && parsed.expiresAt <= this.now()) throw new Error('New memory must not already be expired');
    const { expectedRevision, ...data } = parsed;
    return this.write(data.scope, data.id, expectedRevision, old => {
      const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
      const duplicate = this.list(data.scope).find(r => r.id !== data.id && !r.stale && normalize(r.content) === normalize(data.content));
      if (duplicate) throw new Error(`Duplicate memory: update ${duplicate.id} instead`);
      return { ...data, createdAt: old?.createdAt ?? this.now(), updatedAt: this.now(),
        sourceHash: data.sourceFile ? this.sourceHash(data.sourceFile) : undefined };
    });
  }

  invalidate(scope: MemoryScope, id: string, expectedRevision: string, reason: string): MemoryRecord {
    if (!reason.trim() || reason.length > 1000) throw new Error('A bounded invalidation reason is required');
    return this.write(scope, id, expectedRevision, old => {
      if (!old) throw new Error('Unknown memory');
      return { ...old, invalidated: reason, updatedAt: this.now() };
    });
  }

  search(query: string, limit = 6, scope?: MemoryScope): MemoryRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Memory result limit must be 1..20');
    const chunks = query.toLowerCase().match(/[a-z0-9_./-]+|[\p{Script=Han}]+/gu) ?? [];
    const terms = [...new Set(chunks.flatMap(chunk => /^[\p{Script=Han}]+$/u.test(chunk) && chunk.length > 1
      ? Array.from({ length: chunk.length - 1 }, (_, i) => chunk.slice(i, i + 2)) : [chunk]))];
    const records = (scope ? [scope] : ['project', 'user'] as const).flatMap(s => this.list(s));
    return records.filter(r => !r.stale && r.evidence !== 'hypothesis').map(record => {
      const title = `${record.title} ${record.tags.join(' ')}`.toLowerCase();
      const body = record.content.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (title.includes(term) ? 3 : 0) + (body.includes(term) ? 1 : 0), 0);
      return { record, score };
    }).filter(r => !terms.length || r.score > 0 || (r.record.scope === 'user' && r.record.kind === 'preference'))
      .sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt || a.record.id.localeCompare(b.record.id))
      .slice(0, limit).map(r => r.record);
  }
}
