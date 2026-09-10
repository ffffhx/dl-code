import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { HumanMessage, type AIMessage } from '@langchain/core/messages';
import { createAgent } from 'langchain';
import { z } from 'zod';
import { createSystemPrompt } from '../src/prompts/system-prompt-builder.js';
import { generateToolListPrompt, generateToolUsageGuidelines } from '../src/prompts/tool-prompt.js';
import { ProjectInstructionLoader, createProjectInstructionMiddleware } from '../src/prompts/project-instructions.js';
import { SkillManager } from '../src/skills/SkillManager.js';
import { SkillRuntime } from '../src/skills/SkillRuntime.js';
import { createSkillMiddleware } from '../src/skills/middleware.js';
import { ContextManager } from '../src/context/ContextManager.js';
import type { SessionContext } from '../src/session/types.js';

export const PROMPT_CASES = ['fix-settings', 'scoped-rules', 'edit-recovery', 'read-only'] as const;
export type PromptCase = typeof PROMPT_CASES[number];

/** Constrained real-file fixtures: no generated programs or arbitrary shell commands execute. */
export async function runPromptCase(model: BaseChatModel, scenario: PromptCase, options: { basePrompt?: string; timeoutMs?: number } = {}) {
  const temp = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temp, 'deer-prompt-eval-'));
  const file = path.join(root, 'src', 'options.json');
  const context: SessionContext = { sessionId: 'prompt-eval', messages: [], userName: null, todos: [], createdAt: 1, updatedAt: 1 };
  const budget = new ContextManager();
  let reads = 0;
  let writes = 0;
  let errors = 0;
  let verificationRuns = 0;
  let verifiedVersion = -1;
  let recovered = false;
  let injected = false;
  let readAfterConflict = false;
  let readBeforeEveryWrite = true;
  let lastReadVersion = -1;
  const trace: { tool: string; outcome: string }[] = [];
  const started = Date.now();
  let promptHash = '';
  let final = '';
  let failure: string | undefined;
  let modelCalls = 0;
  let unknownToolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const check = () => {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const expectedNote = injected ? 'concurrent-user-change' : 'user-owned';
      return data.retryLimit === (scenario === 'read-only' ? 0 : 3)
        && data.mode === 'safe' && data.note === expectedNote
        && (scenario !== 'scoped-rules' || data.backoff === 'linear')
        && Object.keys(data).sort().join(',') === (scenario === 'scoped-rules' ? 'backoff,mode,note,retryLimit' : 'mode,note,retryLimit');
    } catch { return false; }
  };
  try {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ retryLimit: 0, mode: 'safe', note: 'user-owned' }, null, 2) + '\n');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Preserve existing mode and note values, including concurrent user changes. After modifying settings, run verify_changes and inspect its result. Do not add unrelated keys.');
    if (scenario === 'scoped-rules') fs.writeFileSync(path.join(root, 'src', 'AGENTS.md'), 'When enabling retries, also set backoff to "linear". retryLimit must not exceed 3.');
    const loader = new ProjectInstructionLoader(root, { userRoot: null, cwd: root });
    const skills = new SkillManager(root, path.join(root, 'no-user-skills'));
    skills.discover();
    const runtime = new SkillRuntime(skills, context);
    const resolveFile = (target: string) => {
      const absolute = path.resolve(root, target);
      if (absolute !== file) throw new Error('This evaluation tool only accesses src/options.json; project rules are provided by load_project_instructions.');
      return absolute;
    };
    const read = (target: string) => {
      const result = fs.readFileSync(resolveFile(target), 'utf8');
      reads++;
      lastReadVersion = writes;
      if (injected) readAfterConflict = true;
      trace.push({ tool: 'read_file', outcome: 'read current settings' });
      return result;
    };
    const readTool = new DynamicStructuredTool({
      name: 'read_file', description: 'Read the current text of src/options.json. Paths may be relative to the project root or absolute.',
      schema: z.object({ path: z.string() }), func: async ({ path: target }) => read(target),
    });
    const editor = new DynamicStructuredTool({
      name: 'text_editor', description: 'View or replace one exact occurrence in src/options.json. Re-read after a mismatch or concurrent change. Cannot create files or execute code.',
      schema: z.object({ command: z.enum(['view', 'str_replace']), path: z.string(), old_str: z.string().optional(), new_str: z.string().optional() }),
      func: async ({ command, path: target, old_str, new_str }) => {
        if (command === 'view') return read(target);
        resolveFile(target);
        if (scenario === 'edit-recovery' && !injected) {
          injected = true;
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          data.note = 'concurrent-user-change';
          fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
          lastReadVersion = -1;
          errors++;
          trace.push({ tool: 'text_editor', outcome: 'injected concurrent edit; replacement rejected' });
          return 'Edit failed: the file changed concurrently. View the current file before retrying; preserve the new user note. No replacement was performed.';
        }
        const body = fs.readFileSync(file, 'utf8');
        if (!old_str || new_str === undefined || body.split(old_str).length !== 2) {
          errors++;
          trace.push({ tool: 'text_editor', outcome: 'replacement mismatch' });
          return 'Edit failed: old_str must match exactly once. Re-read before retrying.';
        }
        readBeforeEveryWrite &&= lastReadVersion === writes;
        fs.writeFileSync(file, body.replace(old_str, () => new_str));
        writes++;
        lastReadVersion = writes;
        if (injected && readAfterConflict) recovered = true;
        trace.push({ tool: 'text_editor', outcome: 'replacement applied' });
        return 'Replacement applied. Validation has not run yet.';
      },
    });
    const verify = new DynamicStructuredTool({
      name: 'verify_changes', description: 'Run deterministic fixture assertions for retryLimit, preservation of user settings and applicable scoped conventions. Returns a pass/fail signal; does not modify files.',
      schema: z.object({}), func: async () => {
        verificationRuns++;
        const passed = check();
        verifiedVersion = passed ? writes : -1;
        trace.push({ tool: 'verify_changes', outcome: passed ? 'PASS' : 'FAIL' });
        return passed ? 'PASS: all settings assertions passed.' : 'FAIL: retryLimit, preserved settings or scoped conventions are incorrect.';
      },
    });
    const tools = [readTool, loader.tool(), ...(scenario === 'read-only' ? [] : [editor, verify])];
    const info = tools.map(tool => ({ name: tool.name, description: tool.description }));
    const base = options.basePrompt === undefined
      ? createSystemPrompt({ projectRoot: root, availableTools: info, isFirstMessage: true })
      : `${options.basePrompt}\n${generateToolListPrompt(info)}\n${generateToolUsageGuidelines(info)}`;
    promptHash = createHash('sha256').update(base.replaceAll(root, '<fixture>')).digest('hex');
    const agent = createAgent({ model, tools, middleware: [
      createSkillMiddleware(runtime, budget, context, () => base + '\n' + loader.prompt(), () => {}),
      createProjectInstructionMiddleware(loader),
    ] });
    const task = scenario === 'read-only'
      ? 'Read src/options.json and explain its current retryLimit and mode. Analysis only: do not change files or claim to have run validation.'
      : 'Fix src/options.json so retryLimit is 3. Preserve unrelated user settings, follow project rules, verify your changes and report the outcome.';
    const result = await agent.invoke({ messages: [new HumanMessage(task)] }, { recursionLimit: 40, signal: AbortSignal.timeout(options.timeoutMs ?? 120000) });
    final = String(result.messages.at(-1)?.content ?? '');
    const replies = result.messages.filter(message => message._getType() === 'ai') as AIMessage[];
    modelCalls = replies.length;
    for (const reply of replies) {
      inputTokens += reply.usage_metadata?.input_tokens ?? 0;
      outputTokens += reply.usage_metadata?.output_tokens ?? 0;
      unknownToolCalls += (reply.tool_calls ?? []).filter(call => !tools.some(tool => tool.name === call.name)).length;
    }
    trace.push(...result.messages.filter(message => message._getType() === 'tool' && String(message.content).includes('Operation was NOT executed'))
      .map(() => ({ tool: 'project_instructions', outcome: 'operation paused for scope loading' })));
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  try {
    const assertions = {
      taskResult: check(),
      readBeforeWrite: reads > 0 && readBeforeEveryWrite,
      verifiedFinalVersion: scenario === 'read-only' || (writes > 0 && verifiedVersion === writes),
      recoveredAfterReread: scenario !== 'edit-recovery' || recovered,
      readOnlyPreserved: scenario !== 'read-only' || (writes === 0 && /\b0\b/.test(final) && /safe/i.test(final)),
      completed: !failure && !!final.trim(),
      registeredToolsOnly: unknownToolCalls === 0,
    };
    return {
      scenario, passed: Object.values(assertions).every(Boolean), assertions, failure, promptHash,
      elapsedMs: Date.now() - started, modelCalls, inputTokens, outputTokens, reads, writes,
      toolErrors: errors + unknownToolCalls, unknownToolCalls, verificationRuns, final, trace,
    };
  } finally {
    budget.cleanup();
    if (path.dirname(root) !== temp || !path.basename(root).startsWith('deer-prompt-eval-')) throw new Error('Unexpected evaluation cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
