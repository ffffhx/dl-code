import { SessionManager } from '../session/index.js';
import chalk from 'chalk';

export function switchCommand(sessionId: string): void {
  const sessionManager = new SessionManager();
  const session = sessionManager.switchSession(sessionId);

  if (session) {
    const userName = session.userName ? chalk.blue(`[${session.userName}]`) : '';
    console.log(
      chalk.green(`✓ Switched to session: ${chalk.bold(sessionId)} ${userName}`)
    );
    console.log(chalk.gray(`  Messages: ${session.messages.length}`));
  } else {
    console.log(chalk.red(`✗ Session not found: ${sessionId}`));
    console.log(chalk.gray('  Use "dl-code list" to see available sessions'));
    process.exit(1);
  }
}
