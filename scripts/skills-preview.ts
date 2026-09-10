import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { SkillManager } from '../src/skills/SkillManager.js';

// Read-only inspection server: no model requests, tool execution or session writes.
const root = path.resolve(process.argv[2] ?? process.cwd());
const manager = new SkillManager(root);
const port = Number(process.env.DEER_SKILLS_PREVIEW_PORT ?? 4322);
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.writeHead(405); res.end('GET only'); return; }
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    manager.discover();
    if (url.pathname === '/') {
      res.end(`Deer-code Skill Preview\nProject: ${root}\n\nGET /skills — discovered metadata\nGET /skills/<name> — full instructions\nGET /skills/<name>?resource=references/checklist.md — text resource\n\n${fs.readFileSync(new URL('../docs/SKILLS.md', import.meta.url), 'utf8')}`);
    } else if (url.pathname === '/skills') {
      res.end(JSON.stringify({ skills: manager.list(), warnings: manager.warnings }, null, 2));
    } else if (/^\/skills\/[^/]+$/.test(url.pathname)) {
      const name = decodeURIComponent(url.pathname.slice('/skills/'.length));
      const resource = url.searchParams.get('resource');
      res.end(JSON.stringify(resource ? manager.readResource(name, resource) : manager.load(name), null, 2));
    } else { res.writeHead(404); res.end('Not found'); }
  } catch (error) {
    res.writeHead(400);
    res.end(error instanceof Error ? error.message : String(error));
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Skills preview: http://127.0.0.1:${port}`));
