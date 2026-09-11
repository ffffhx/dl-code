import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDataDirectory } from '../src/paths.js';
import { SessionManager } from '../src/session/SessionManager.js';
import { SkillManager } from '../src/skills/SkillManager.js';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-rename-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('dl-rename-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('new installations select .dl-code without creating or moving data', t => {
  const root = fixture(t);
  assert.equal(resolveDataDirectory(root), path.join(root, '.dl-code'));
  assert.deepEqual(fs.readdirSync(root), []);
});

test('renamed application can reopen the legacy current session', t => {
  const root = fixture(t);
  const legacy = path.join(root, '.deer-code');
  const old = new SessionManager(legacy).createSession('existing user');
  const restored = new SessionManager(resolveDataDirectory(root)).getCurrentSession();
  assert.equal(restored.sessionId, old.sessionId);
  assert.equal(restored.userName, 'existing user');
  assert.ok(!fs.existsSync(path.join(root, '.dl-code')));
});

test('legacy project skills remain available; an explicit new directory takes precedence', t => {
  const root = fixture(t);
  const legacy = path.join(root, '.deer-code', 'skills', 'review');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'SKILL.md'), '---\nname: review\ndescription: Review code\n---\nRead the implementation.');
  const skills = new SkillManager(root, path.join(root, 'empty-user-skills'));
  assert.equal(skills.discover()[0]?.name, 'review');
  fs.mkdirSync(path.join(root, '.dl-code'));
  assert.equal(resolveDataDirectory(root), path.join(root, '.dl-code'));
  assert.deepEqual(skills.discover(), []);
  assert.ok(fs.existsSync(path.join(legacy, 'SKILL.md')));
});
