import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import type { LoadedSkill, SkillMetadata } from './types.js';

const MAX_FILE_BYTES = 128 * 1024;

function readText(file: string): string {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    throw new Error(`Expected a text file of at most ${MAX_FILE_BYTES} bytes: ${file}`);
  }
  const content = fs.readFileSync(file, 'utf8');
  if (content.includes('\0') || Buffer.byteLength(content) > MAX_FILE_BYTES) {
    throw new Error(`Invalid or oversized text file: ${file}`);
  }
  return content;
}

function parseSkill(text: string): { name: string; description: string; body: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new Error('SKILL.md needs YAML frontmatter');
  const data = parse(match[1]) as Record<string, unknown> | null;
  if (!data || typeof data.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name) || data.name.length > 64) {
    throw new Error('name must be lowercase letters, digits and single hyphens (max 64 characters)');
  }
  if (typeof data.description !== 'string' || !data.description.trim() || data.description.length > 1024) {
    throw new Error('description must contain 1–1024 characters');
  }
  if (!match[2].trim()) throw new Error('Skill instructions must not be empty');
  return { name: data.name, description: data.description.trim(), body: match[2].trim() };
}

function within(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export class SkillManager {
  private registry = new Map<string, SkillMetadata>();
  readonly warnings: string[] = [];

  constructor(
    readonly projectRoot: string,
    readonly userRoot = path.join(os.homedir(), '.deer-code', 'skills'),
  ) {}

  discover(): SkillMetadata[] {
    this.registry.clear();
    this.warnings.length = 0;
    const roots = [
      { root: this.userRoot, source: 'user' as const },
      { root: path.join(this.projectRoot, '.deer-code', 'skills'), source: 'project' as const },
    ];
    for (const { root, source } of roots) {
      if (!fs.existsSync(root)) continue;
      try {
        const seen = new Set<string>();
        for (const folder of fs.readdirSync(root).sort()) {
          const entry = path.join(root, folder, 'SKILL.md');
          if (!fs.existsSync(entry)) continue;
          try {
            // A skill directory may itself be a user-managed symlink.
            const directory = fs.realpathSync(path.join(root, folder));
            const entryPath = fs.realpathSync(entry);
            if (!within(directory, entryPath)) throw new Error('SKILL.md escapes its skill directory');
            const { name, description } = parseSkill(readText(entryPath));
            if (seen.has(name)) throw new Error(`Duplicate skill name in ${source} scope: ${name}`);
            seen.add(name);
            this.registry.set(name, { name, description, directory, entryPath, source });
          } catch (error) {
            this.warnings.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } catch (error) {
        this.warnings.push(`${root}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return this.list();
  }

  list(): SkillMetadata[] {
    return [...this.registry.values()].sort((a, b) => a.name.localeCompare(b.name)).map(s => ({ ...s }));
  }

  load(name: string): LoadedSkill {
    const metadata = this.registry.get(name);
    if (!metadata) throw new Error(`Unknown skill: ${name}. Use a name from Available skills.`);
    if (fs.realpathSync(metadata.entryPath) !== metadata.entryPath) throw new Error(`Skill path changed: ${name}`);
    const text = readText(metadata.entryPath);
    const parsed = parseSkill(text);
    if (parsed.name !== name) throw new Error(`Skill renamed on disk: ${name}. Retry the next turn to refresh discovery.`);
    return { ...metadata, ...parsed, hash: createHash('sha256').update(text).digest('hex') };
  }

  readResource(name: string, relativePath: string): { path: string; content: string } {
    const skill = this.load(name);
    if (!relativePath || path.isAbsolute(relativePath) || /^[a-z]:/i.test(relativePath)) {
      throw new Error('Provide a path relative to the skill directory');
    }
    const candidate = path.resolve(skill.directory, relativePath);
    if (!within(skill.directory, candidate)) throw new Error('Resource path escapes the skill directory');
    const resolved = fs.realpathSync(candidate);
    if (!within(skill.directory, resolved)) throw new Error('Resource symlink escapes the skill directory');
    return { path: resolved, content: readText(resolved) };
  }
}
