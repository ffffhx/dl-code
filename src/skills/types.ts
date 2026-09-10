export interface SkillMetadata {
  name: string;
  description: string;
  directory: string;
  entryPath: string;
  source: 'user' | 'project';
}

/** Persist references, never trust saved instructions without re-reading disk. */
export interface ActiveSkill {
  name: string;
  entryPath: string;
  hash: string;
}

export interface LoadedSkill extends SkillMetadata {
  body: string;
  hash: string;
}
