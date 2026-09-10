import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentJournal } from '../agents/subagents/AgentJournal.js';

export function agentsCommand(rootId?: string): void {
  const base = path.join(os.homedir(), '.deer-code', 'agents');
  if (!fs.existsSync(base)) { console.log('[]'); return; }
  if (!rootId) { console.log(JSON.stringify(fs.readdirSync(base).filter(id => fs.statSync(path.join(base, id)).isDirectory()), null, 2)); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(rootId)) throw new Error('Invalid root session ID');
  const directory = path.join(base, rootId);
  if (!fs.existsSync(directory)) throw new Error('No agent records for this root session');
  console.log(JSON.stringify(new AgentJournal(directory).load().map(record => ({
    id: record.id, parentId: record.parentId, task: record.task, status: record.status,
    result: record.result, error: record.error, pendingMessages: record.inbox.length,
    messageCount: record.context.messages.length,
  })), null, 2));
}
