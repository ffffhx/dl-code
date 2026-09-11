import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Select one data tree; never move or merge live journals during startup. */
export function resolveDataDirectory(base = os.homedir()): string {
  const current = path.join(base, '.dl-code');
  const legacy = path.join(base, '.deer-code');
  return fs.existsSync(current) || !fs.existsSync(legacy) ? current : legacy;
}
