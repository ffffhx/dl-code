import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { serializeMessages, deserializeMessages } from '../../session/SessionManager.js';
import type { AgentRecord } from './types.js';

/** Append a durable event first; metadata is an atomically replaced inspection snapshot. */
export class AgentJournal {
  private previous = new Map<string, string[]>();
  constructor(readonly directory: string) { fs.mkdirSync(directory, { recursive: true }); }

  claim(): () => void {
    const file = path.join(this.directory, '.owner.json');
    if (fs.existsSync(file)) {
      const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid agent journal owner');
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
      }
      if (alive) throw new Error('This agent session is already managed by another runtime');
      fs.unlinkSync(file);
    }
    const token = randomUUID();
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
    return () => {
      if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file);
    };
  }

  private folder(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid agent ID');
    return path.join(this.directory, id);
  }

  save(record: AgentRecord, event: string): void {
    const folder = this.folder(record.id);
    fs.mkdirSync(folder, { recursive: true });
    const messages = serializeMessages(record.context.messages);
    const serialized = messages.map(m => JSON.stringify(m));
    const previous = this.previous.get(record.id) ?? [];
    const append = previous.length <= serialized.length && previous.every((m, i) => serialized[i] === m);
    const state = { ...record, context: { ...record.context, messages: undefined } };
    const entry = { event, at: Date.now(), state, reset: !append, messages: append ? messages.slice(previous.length) : messages };
    const fd = fs.openSync(path.join(folder, 'events.jsonl'), 'a');
    try { fs.writeSync(fd, `${JSON.stringify(entry)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.previous.set(record.id, serialized);
    const temporary = path.join(folder, 'metadata.json.tmp');
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
    fs.renameSync(temporary, path.join(folder, 'metadata.json'));
  }

  load(repairTail = false): AgentRecord[] {
    const records: AgentRecord[] = [];
    for (const id of fs.readdirSync(this.directory).sort()) {
      if (!/^[a-zA-Z0-9_-]+$/.test(id) || !fs.statSync(path.join(this.directory, id)).isDirectory()) continue;
      const log = path.join(this.folder(id), 'events.jsonl');
      if (!fs.existsSync(log)) continue;
      const text = fs.readFileSync(log, 'utf8');
      // A crash can leave only the final line incomplete. Remove that tail before appending.
      const end = text.lastIndexOf('\n') + 1;
      if (repairTail && end < text.length) fs.truncateSync(log, Buffer.byteLength(text.slice(0, end)));
      let record: AgentRecord | undefined;
      let messages: ReturnType<typeof serializeMessages> = [];
      for (const line of text.slice(0, end).split('\n').filter(Boolean)) {
        const entry = JSON.parse(line);
        messages = entry.reset ? entry.messages : [...messages, ...entry.messages];
        record = { ...entry.state, context: { ...entry.state.context, messages: deserializeMessages(messages) } };
      }
      if (record) {
        if (record.id !== id) throw new Error(`Journal ID mismatch: ${id}`);
        this.previous.set(id, messages.map(m => JSON.stringify(m)));
        records.push(record);
      }
    }
    return records;
  }
}
