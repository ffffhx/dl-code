import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { createAgent } from 'langchain';
import { z } from 'zod';
import { createSystemPrompt } from '../src/prompts/system-prompt-builder.js';
import { ProjectInstructionLoader, createProjectInstructionMiddleware } from '../src/prompts/project-instructions.js';
import { generateToolUsageGuidelines } from '../src/prompts/tool-prompt.js';
import { SkillManager } from '../src/skills/SkillManager.js';
import { SkillRuntime } from '../src/skills/SkillRuntime.js';
import { createSkillMiddleware } from '../src/skills/middleware.js';
import { ContextManager } from '../src/context/ContextManager.js';
import type { SessionContext } from '../src/session/types.js';

function fixture(t: TestContext) {
  const temp = fs.realpathSync(os.tmpdir());
  const home = fs.mkdtempSync(path.join(temp, 'dl-prompts-test-'));
  t.after(() => {
    assert.equal(path.dirname(home), temp);
    assert.ok(path.basename(home).startsWith('dl-prompts-test-'));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const root = path.join(home, 'project');
  const user = path.join(home, 'user');
  fs.mkdirSync(root);
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const loader = () => new ProjectInstructionLoader(root, { userRoot: user, cwd: root });
  return { home, root, user, write, loader };
}

test('tool guidance follows the actual registry and context switches are independent', () => {
  const tools = [{ name: 'read_file', description: 'Read only', category: 'builtin' as const }];
  const prompt = createSystemPrompt({ projectRoot: '/test-root', userName: 'TEST_USER', isFirstMessage: true, availableTools: tools }, { includeProjectInfo: false });
  assert.match(prompt, /read_file/);
  assert.doesNotMatch(prompt, /text_editor:|bash:|todo_write:|Use Glob|Prefer Read tool/);
  assert.doesNotMatch(prompt, /Project Root Directory:/);
  assert.match(prompt, /TEST_USER/);
  const hiddenUser = createSystemPrompt({ projectRoot: '/test-root', userName: 'TEST_USER', isFirstMessage: false, availableTools: [] }, { includeUserInfo: false });
  assert.doesNotMatch(hiddenUser, /TEST_USER/);
  assert.match(hiddenUser, /Project Root Directory: \/test-root/);
  assert.equal(generateToolUsageGuidelines([]), '');
});

test('global, root and scoped rules load in order without sibling leakage; overrides and fallbacks work', t => {
  const f = fixture(t);
  f.write(path.join(f.user, 'AGENTS.md'), 'GLOBAL_RULE');
  f.write(path.join(f.root, 'AGENTS.md'), 'ROOT_RULE');
  f.write(path.join(f.root, 'src/ui/AGENTS.override.md'), 'UI_OVERRIDE');
  f.write(path.join(f.root, 'src/ui/AGENTS.md'), 'SHADOWED_UI');
  f.write(path.join(f.root, 'src/api/CLAUDE.md'), 'API_FALLBACK');
  const loader = f.loader();
  const initial = loader.prompt();
  assert.ok(initial.indexOf('GLOBAL_RULE') < initial.indexOf('ROOT_RULE'));
  assert.doesNotMatch(initial, /UI_OVERRIDE|API_FALLBACK/);
  assert.match(loader.prepare('src/ui/new.ts').pause!, /NOT executed/);
  const ui = loader.prompt();
  assert.match(ui, /UI_OVERRIDE/);
  assert.doesNotMatch(ui, /SHADOWED_UI|API_FALLBACK/);
  assert.equal(loader.prepare('src/ui/new.ts').pause, undefined);
  loader.prepare('src/api/index.ts');
  assert.match(loader.prompt(), /API_FALLBACK/);
  assert.doesNotMatch(f.loader().prompt(), /UI_OVERRIDE|API_FALLBACK/);
});

test('parallel accesses and rule changes require a model boundary before execution', t => {
  const f = fixture(t);
  const rules = path.join(f.root, 'nested/AGENTS.md');
  f.write(rules, 'FIRST_VERSION');
  const loader = f.loader();
  loader.prompt();
  assert.ok(loader.prepare('nested/a.ts').pause);
  assert.ok(loader.prepare('nested/b.ts').pause);
  loader.prompt();
  assert.equal(loader.prepare('nested/a.ts').pause, undefined);
  f.write(rules, 'SECOND_VERSION');
  assert.ok(loader.prepare('nested/a.ts').pause);
  assert.match(loader.prompt(), /SECOND_VERSION/);
  assert.equal(loader.prepare('nested/a.ts').pause, undefined);
});

test('rule budgets and malformed overrides produce visible errors without partial instructions', t => {
  const f = fixture(t);
  f.write(path.join(f.root, 'AGENTS.override.md'), '界'.repeat(20));
  f.write(path.join(f.root, 'AGENTS.md'), 'FALLBACK_MUST_NOT_HIDE_ERROR');
  const loader = new ProjectInstructionLoader(f.root, { userRoot: null, maxBytes: 32 });
  assert.match(loader.prompt(), /budget exceeded/);
  assert.doesNotMatch(loader.prompt(), /FALLBACK_MUST_NOT_HIDE_ERROR|界/);
  assert.match(loader.prepare('x.ts').pause!, /NOT executed/);
  f.write(path.join(f.root, 'AGENTS.override.md'), '');
  f.write(path.join(f.root, 'AGENTS.md'), 'VALID');
  assert.match(loader.prompt(), /VALID/);
  assert.equal(loader.prepare('x.ts').pause, undefined);
});

test('history restores only accessed scopes; explicit tool loads scope for shell work', async t => {
  const f = fixture(t);
  f.write(path.join(f.root, 'nested/AGENTS.md'), 'RESTORED_RULE');
  const history = [new AIMessage({ content: '', tool_calls: [{ name: 'read_file', args: { path: 'nested/file.ts' }, id: 'old' }] })];
  const loader = f.loader();
  loader.restore(history);
  assert.match(loader.prompt(), /RESTORED_RULE/);
  const fresh = f.loader();
  assert.match(String(await fresh.tool().invoke({ paths: ['nested/new.ts'] })), /RESTORED_RULE/);
  assert.match(fresh.prompt(), /RESTORED_RULE/);
  assert.match(String(await fresh.tool().invoke({ paths: [f.home] })), /outside this project/);
});

test('symlinked directories use canonical scopes and cannot import external directory rules', t => {
  const f = fixture(t);
  f.write(path.join(f.root, 'real/AGENTS.md'), 'CANONICAL_RULE');
  f.write(path.join(f.home, 'outside/AGENTS.md'), 'EXTERNAL_RULE');
  try {
    fs.symlinkSync(path.join(f.root, 'real'), path.join(f.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.symlinkSync(path.join(f.home, 'outside'), path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('symlinks unavailable'); return; }
    throw error;
  }
  const loader = f.loader();
  loader.observe('alias/new.ts');
  loader.observe('escape/new.ts');
  assert.match(loader.prompt(), /CANONICAL_RULE/);
  assert.doesNotMatch(loader.prompt(), /EXTERNAL_RULE/);
});

class ScriptedModel extends BaseChatModel {
  requests: BaseMessage[][] = [];
  constructor(private replies: AIMessage[]) { super({}); }
  _llmType() { return 'prompt-regression'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    this.requests.push(messages);
    const message = this.replies.shift();
    assert.ok(message, 'unexpected extra model request');
    return { generations: [{ text: '', message }] };
  }
}

test('real agent graph pauses an edit until scoped rules are in the model request', async t => {
  const f = fixture(t);
  f.write(path.join(f.root, 'src/AGENTS.md'), 'SCOPED_GRAPH_RULE');
  const loader = f.loader();
  let edits = 0;
  const editor = new DynamicStructuredTool({ name: 'text_editor', description: 'Fixture editor', schema: z.object({ path: z.string() }), func: async () => { edits++; return 'edited'; } });
  const call = (id: string) => new AIMessage({ content: '', tool_calls: [{ name: 'text_editor', args: { path: 'src/new.ts' }, id }] });
  const model = new ScriptedModel([call('1'), call('2'), new AIMessage('Done')]);
  const context: SessionContext = { sessionId: 'prompt-test', messages: [], userName: null, todos: [], createdAt: 1, updatedAt: 1 };
  const manager = new SkillManager(f.root, path.join(f.home, 'empty-skills'));
  manager.discover();
  const runtime = new SkillRuntime(manager, context);
  const budget = new ContextManager();
  t.after(() => budget.cleanup());
  const agent = createAgent({ model, tools: [editor, loader.tool()], middleware: [
    createSkillMiddleware(runtime, budget, context, () => 'Base\n' + loader.prompt(), () => {}),
    createProjectInstructionMiddleware(loader),
  ] });
  const result = await agent.invoke({ messages: [new HumanMessage('Edit src/new.ts')] });
  assert.equal(edits, 1);
  assert.doesNotMatch(String(model.requests[0][0].content), /SCOPED_GRAPH_RULE/);
  assert.match(String(model.requests[1][0].content), /SCOPED_GRAPH_RULE/);
  assert.ok(result.messages.some(message => String(message.content).includes('NOT executed')));
  assert.ok(result.messages.some(message => message.content === 'edited'));
});
