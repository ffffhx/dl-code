import { createCliRenderer } from '@opentui/core';
import { TerminalApp } from '../ui/terminal-app.js';
import { SessionManager } from '../session/index.js';
import { initializeMCPServers } from '../mcp/index.js';
import { getConfigSection } from '../config/index.js';
import { startupLogger } from '../utils/startup-logger.js';
import { createAgentSession } from '../runtime/default.js';
import { getGlobalMCPManager } from '../mcp/index.js';

export interface StartOptions {
  new?: boolean;
  name?: string;
}

export async function startCommand(options: StartOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('dl-code requires an interactive terminal. Run npm start in PowerShell or Windows Terminal.');
  }
  let session: Awaited<ReturnType<typeof createAgentSession>> | undefined;
  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | undefined;
  let app: TerminalApp | undefined;
  const stop = () => { void app?.close().catch(error => { process.exitCode = 1; console.error(error); }); };
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

    session = await createAgentSession();
    renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [],
      screenMode: 'alternate-screen', targetFps: 30, maxFps: 30, useMouse: true,
      consoleMode: 'console-overlay', openConsoleOnError: false });
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    app = new TerminalApp(renderer, session, finish);
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    await done;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    app?.dispose();
    renderer?.destroy();
    if (session) await session.shutdown();
    else await getGlobalMCPManager().disconnectAll();
  }
}
