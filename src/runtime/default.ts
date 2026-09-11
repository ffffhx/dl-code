import { CodingAgent } from '../agents/coding-agent.js';
import { createSubagentManager } from '../agents/subagents/runtime.js';
import { SessionManager } from '../session/SessionManager.js';
import { getGlobalMCPManager } from '../mcp/index.js';
import { AgentSession } from './AgentSession.js';

export async function createAgentSession(): Promise<AgentSession> {
  const sessions = new SessionManager();
  const context = sessions.getCurrentSession();
  const agents = createSubagentManager(context.sessionId);
  let engine: CodingAgent | undefined;
  try {
    engine = new CodingAgent();
    return new AgentSession({ context, engine, agents, save: state => sessions.saveSession(state, true),
      closeConnections: () => getGlobalMCPManager().disconnectAll() });
  } catch (error) {
    await agents.shutdown();
    await engine?.cleanup();
    throw error;
  }
}
