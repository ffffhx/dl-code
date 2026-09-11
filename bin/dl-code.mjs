#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const bunPackage = require('bun/package.json');
const bun = resolve(dirname(require.resolve('bun/package.json')), bunPackage.bin.bun);
const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const result = spawnSync(bun, [entry, ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) console.error('Cannot start dl-code. Run npm install and npm run build.', result.error.message);
process.exitCode = result.status ?? 1;
