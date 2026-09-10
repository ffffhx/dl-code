import path from 'node:path';
import { SkillManager } from '../skills/SkillManager.js';

export function skillsCommand(dir: string, name?: string, resource?: string): void {
  const manager = new SkillManager(path.resolve(dir));
  const skills = manager.discover();
  for (const warning of manager.warnings) console.error(`[Skills] ${warning}`);
  if (resource && !name) throw new Error('Specify a skill name when reading a resource');
  console.log(JSON.stringify(
    name ? (resource ? manager.readResource(name, resource) : manager.load(name)) : skills,
    null, 2,
  ));
}
