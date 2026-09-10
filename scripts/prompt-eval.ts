import fs from 'node:fs';
import path from 'node:path';
import { initChatModel } from '../src/models/chat-model.js';
import { getConfigSection } from '../src/config/config.js';
import { PROMPT_CASES, runPromptCase, type PromptCase } from './prompt-eval-cases.js';

const args = process.argv.slice(2);
const usage = 'npm run eval:prompts:live -- --live [--case fix-settings|scoped-rules|edit-recovery|read-only] [--repeat 3] [--label candidate] [--prompt-file baseline.txt] [--output results.json]';
if (args.includes('--help')) { console.log(usage); process.exit(0); }
if (!args.includes('--live')) { console.error('Live evaluation calls the configured model. Use --live explicitly.\n' + usage); process.exit(1); }
const values = new Map<string, string>();
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--live') continue;
  if (!['--case', '--repeat', '--label', '--prompt-file', '--output'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(usage);
  values.set(args[i], args[++i]);
}
const repeat = Number(values.get('--repeat') ?? 1);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) throw new Error('--repeat must be between 1 and 10');
const selected = values.get('--case');
if (selected && !PROMPT_CASES.includes(selected as PromptCase)) throw new Error('Unknown case: ' + selected);
const cases = selected ? [selected as PromptCase] : [...PROMPT_CASES];
const promptFile = values.get('--prompt-file');
const basePrompt = promptFile ? fs.readFileSync(path.resolve(promptFile), 'utf8') : undefined;
const output = path.resolve(values.get('--output') ?? path.join('.deer-code', 'evals', `prompts-${Date.now()}.json`));
const model = initChatModel();
const results: Awaited<ReturnType<typeof runPromptCase>>[] = [];
const configuredModel = getConfigSection(['models', 'chat_model'])?.model;
const report = () => ({
  suiteVersion: 1, label: values.get('--label') ?? 'candidate', model: configuredModel,
  createdAt: new Date().toISOString(), repeats: repeat,
  passed: results.filter(result => result.passed).length, total: results.length, results,
  limitations: 'Constrained JSON editing fixtures, not an arbitrary-code benchmark. Automated grades cover file state and tool evidence; review final text manually for unsupported claims. Usage is provider-reported when available; zero may mean unreported.',
});
for (let round = 0; round < repeat; round++) {
  for (const scenario of cases) {
    console.log(`[${round + 1}/${repeat}] ${scenario}`);
    const result = await runPromptCase(model, scenario, { basePrompt });
    results.push(result);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report(), null, 2) + '\n');
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${scenario}: ${result.elapsedMs}ms, ${result.modelCalls} model calls`);
  }
}
console.log(`Report: ${output}`);
process.exitCode = results.every(result => result.passed) ? 0 : 1;
