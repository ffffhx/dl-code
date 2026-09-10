import React from 'react';
import { render } from 'ink';
import { App } from '../ui/App.js';
import { SessionManager } from '../session/index.js';
import { initializeMCPServers } from '../mcp/index.js';
import { getConfigSection } from '../config/index.js';
import { startupLogger } from '../utils/startup-logger.js';
import { createDefaultHarness } from '../harness/default.js';
import { getGlobalMCPManager } from '../mcp/index.js';

export interface StartOptions {
  new?: boolean;
  name?: string;
}

export async function startCommand(options: StartOptions): Promise<void> {

  const mcpServersConfig = getConfigSection(['tools', 'mcp_servers']);
  if (mcpServersConfig) {
    try {
      await initializeMCPServers(mcpServersConfig);
    } catch (error) {
      console.error('[MCP] Failed to initialize MCP servers:', error);
    }
  }

  if (options.new) {
    const sessionManager = new SessionManager();
    const context = sessionManager.createSession(options.name || null);
    const message = `✨ Created new session: ${context.sessionId}`;
    startupLogger.log(message, 'info');
  }

  let harness: Awaited<ReturnType<typeof createDefaultHarness>> | undefined;
  try {
    harness = await createDefaultHarness();
    const view = render(React.createElement(App, { harness }), { exitOnCtrlC: false });
    await view.waitUntilExit();
  } finally {
    if (harness) await harness.shutdown();
    else await getGlobalMCPManager().disconnectAll();
  }
}
