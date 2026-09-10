import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { runPromptCase, type PromptCase } from '../scripts/prompt-eval-cases.js';

class FixtureModel extends BaseChatModel {
  private step = 0;
  private id = 0;
  private pending?: { name: string; args: Record<string, unknown> };
  constructor(private scenario: PromptCase, private skipVerification = false) { super({}); }
  _llmType() { return 'evaluation-harness-test'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    const last = String(messages.at(-1)?.content ?? '');
    const call = (name: string, args: Record<string, unknown>) => {
      this.pending = { name, args };
      const message = new AIMessage({ content: '', tool_calls: [{ name, args, id: String(++this.id) }] });
      return { generations: [{ text: '', message }] };
    };
    if (last.includes('Operation was NOT executed')) return call(this.pending!.name, this.pending!.args);
    if (last.startsWith('Edit failed:')) {
      this.step = 1;
      return call('read_file', { path: 'src/options.json' });
    }
    if (this.step++ === 0) return call('read_file', { path: 'src/options.json' });
    if (this.scenario === 'read-only') return { generations: [{ text: '', message: new AIMessage('retryLimit is 0 and mode is safe. No validation was run.') }] };
    if (this.step === 2) return call('text_editor', {
      command: 'str_replace', path: 'src/options.json', old_str: '"retryLimit": 0',
      new_str: this.scenario === 'scoped-rules' ? '"retryLimit": 3,\n  "backoff": "linear"' : '"retryLimit": 3',
    });
    if (this.step === 3 && !this.skipVerification) return call('verify_changes', {});
    return { generations: [{ text: '', message: new AIMessage('Settings fixed. Verification passed.') }] };
  }
}

for (const scenario of ['fix-settings', 'scoped-rules', 'edit-recovery', 'read-only'] as const) {
  test(`behavior harness grades the ${scenario} fixture using file and tool evidence`, async () => {
    const result = await runPromptCase(new FixtureModel(scenario), scenario);
    assert.equal(result.passed, true, JSON.stringify(result));
    if (scenario !== 'read-only') assert.equal(result.verificationRuns, 1);
    if (scenario === 'edit-recovery') assert.equal(result.toolErrors, 1);
  });
}

test('claiming verification passed without executing it fails the behavior grade', async () => {
  const result = await runPromptCase(new FixtureModel('fix-settings', true), 'fix-settings');
  assert.equal(result.assertions.taskResult, true);
  assert.equal(result.assertions.verifiedFinalVersion, false);
  assert.equal(result.passed, false);
});
