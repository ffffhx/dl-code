import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { BashTerminal } from './bash-terminal.js';

export function createBashTool(projectRoot: string) {
  let terminal: BashTerminal | undefined;
  let running = false;
  const close = async () => { const owned = terminal; terminal = undefined; await owned?.close(); };
  const tool = new DynamicStructuredTool({
    name: 'bash', description: 'Execute a command in this agent\'s own persistent non-interactive shell (PowerShell on Windows, Bash elsewhere). Returns output and exit code. Interactive programs are not supported.',
    schema: z.object({ command: z.string(), reset_cwd: z.boolean().nullable().default(false) }),
    func: async ({ command, reset_cwd }, _runManager, config) => {
      config?.signal?.throwIfAborted();
      if (running) return 'Shell busy: wait for this agent\'s current command before starting another.';
      running = true;
      try {
        if (reset_cwd) await close();
        terminal ??= new BashTerminal(projectRoot);
        return await terminal.execute(command, 30000, config?.signal);
      }
      catch (error) { await close(); return `Shell error: ${String(error)}`; }
      finally { running = false; }
    },
  });
  return { tool, close };
}
