import React from 'react';
import { render, Text } from 'ink';
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
  const view = render(React.createElement(Text, null, 'Loading DeerCode: connecting tools...'), { exitOnCtrlC: false });
  let harness: Awaited<ReturnType<typeof createDefaultHarness>> | undefined;
  try {
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

    view.rerender(React.createElement(Text, null, 'Loading DeerCode: restoring session...'));
    harness = await createDefaultHarness();
    view.rerender(React.createElement(App, { harness }));
    await view.waitUntilExit();
  } finally {
    view.unmount();
    if (harness) await harness.shutdown();
    else await getGlobalMCPManager().disconnectAll();
  }
}
