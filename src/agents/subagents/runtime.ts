import os from 'node:os';
import path from 'node:path';
import { CodingAgent } from '../coding-agent.js';
import { AgentManager } from './AgentManager.js';
import { AgentJournal } from './AgentJournal.js';

export function createAgentManager(rootId: string): AgentManager {
  if (!/^[a-zA-Z0-9_-]+$/.test(rootId)) throw new Error('Invalid root session ID');
  return new AgentManager(rootId, new AgentJournal(path.join(os.homedir(), '.deer-code', 'agents', rootId)), () => {
    const agent = new CodingAgent([], { readOnly: true });
    return {
      run: async (context, control) => {
        for await (const chunk of agent.execute(context, control.onContextChange, control)) { void chunk; /* journaled by the callback */ }
        const last = [...context.messages].reverse().find(message => message._getType() === 'ai' && message.content);
        return typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? 'No final response');
      },
      cleanup: () => agent.cleanup(),
    };
  });
}
