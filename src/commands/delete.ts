import { SessionManager } from '../session/index.js';
import chalk from 'chalk';

export function deleteCommand(sessionId: string, force: boolean = false): void {
  const sessionManager = new SessionManager();
  const currentSessionId = sessionManager.getCurrentSessionId();

  if (sessionId === currentSessionId && !force) {
    console.log(chalk.red(`✗ Cannot delete current session: ${sessionId}`));
    console.log(chalk.gray('  Switch to another session first, or use --force'));
    process.exit(1);
  }

  const success = sessionManager.deleteSession(sessionId);

  if (success) {
    console.log(chalk.green(`✓ Deleted session: ${chalk.bold(sessionId)}`));
  } else {
    console.log(chalk.red(`✗ Session not found: ${sessionId}`));
    console.log(chalk.gray('  Use "dl-code list" to see available sessions'));
    process.exit(1);
  }
}
