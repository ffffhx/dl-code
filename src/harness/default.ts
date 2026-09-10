import { CodingAgent } from '../agents/coding-agent.js';
import { createAgentManager } from '../agents/subagents/runtime.js';
import { SessionManager } from '../session/SessionManager.js';
import { getGlobalMCPManager } from '../mcp/index.js';
import { HarnessRuntime } from './HarnessRuntime.js';

export async function createDefaultHarness(): Promise<HarnessRuntime> {
  const sessions = new SessionManager();
  const context = sessions.getCurrentSession();
  const agents = createAgentManager(context.sessionId);
  let engine: CodingAgent | undefined;
  try {
    engine = new CodingAgent();
    return new HarnessRuntime({ context, engine, agents, save: state => sessions.saveSession(state, true),
      closeConnections: () => getGlobalMCPManager().disconnectAll() });
  } catch (error) {
    await agents.shutdown();
    await engine?.cleanup();
    throw error;
  }
}
