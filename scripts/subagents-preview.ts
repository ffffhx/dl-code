import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { AgentManager } from '../src/agents/subagents/AgentManager.js';
import { AgentJournal } from '../src/agents/subagents/AgentJournal.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deer-subagents-preview-'));
const manager = new AgentManager('demo-root', new AgentJournal(directory), record => ({
  run: async (context, control) => {
    const mail = control.takeMessages();
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(control.signal.reason); };
      const timer = setTimeout(() => { control.signal.removeEventListener('abort', abort); resolve(); }, record.task === 'cancel-demo' ? 30000 : 1000);
      control.signal.addEventListener('abort', abort, { once: true });
      if (control.signal.aborted) abort();
    });
    const result = `Offline demo completed; received ${mail.length} parent message(s). No model API was called.`;
    context.messages.push(new AIMessage(result)); control.onContextChange(context); return result;
  }, cleanup: () => {},
}));
manager.attachRoot({ sessionId: 'demo-root', messages: [], userName: null, todos: [], createdAt: Date.now(), updatedAt: Date.now() });
const first = manager.spawn('message-demo');
const second = manager.spawn('cancel-demo');
manager.sendMessage(first.id, 'Focus on the project entry point. This is an offline demonstration.');
setTimeout(() => { void manager.cancel(second.id); }, 500);
const port = Number(process.env.DEER_SUBAGENTS_PREVIEW_PORT ?? 4323);
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') { res.writeHead(405); res.end('GET only'); return; }
  if (req.url === '/') res.end(fs.readFileSync(new URL('../docs/SUBAGENTS.md', import.meta.url), 'utf8'));
  else if (req.url === '/agents') res.end(JSON.stringify({ mode: 'offline demonstration', agents: manager.list() }, null, 2));
  else if (req.url === '/events') res.end(manager.list().map(r => `${r.id}\n${fs.readFileSync(path.join(directory, r.id, 'events.jsonl'), 'utf8')}`).join('\n'));
  else { res.writeHead(404); res.end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Subagents preview: http://127.0.0.1:${port}/`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void manager.shutdown().finally(() => server.close()); });
