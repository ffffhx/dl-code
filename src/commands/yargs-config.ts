import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { project } from '../project.js';
import { skillsCommand } from './skills.js';
import { agentsCommand } from './agents.js';
import {
  startCommand,
  listCommand,
  switchCommand,
  deleteCommand,
  infoCommand,
} from './index.js';

// 处理用户在终端中输入的命令
export function setupYargs(argv: string[]) {
  return yargs(hideBin(argv))
    // CLI工具名称
    .scriptName('dl-code')
    .usage('$0 <command> [options]')
    .version('0.1.0')
    // 如果没有输入任何命令，则执行默认命令
    .command(
      ['start [dir]', '$0 [dir]'],
      'Start the AI coding assistant',
      (yargs) => {
        return yargs
          .positional('dir', {
            describe: 'Project directory',
            type: 'string',
            default: process.cwd(),
          })
          .option('new', {
            alias: 'n',
            describe: 'Create a new session',
            type: 'boolean',
            default: true,
          })
          .option('name', {
            describe: 'User name for the session',
            type: 'string',
          });
      },
      async (argv) => {
        if (argv.dir) {
          project.rootDir = argv.dir;
        }
        await startCommand({
          new: argv.new,
          name: argv.name,
        });
      }
    )
    .command(
      'list',
      'List all sessions',
      () => {},
      () => {
        listCommand();
      }
    )
    .command(
      'switch <sessionId>',
      'Switch to a different session',
      (yargs) => {
        return yargs.positional('sessionId', {
          describe: 'Session ID to switch to',
          type: 'string',
          demandOption: true,
        });
      },
      (argv) => {
        switchCommand(argv.sessionId as string);
      }
    )
    .command(
      'delete <sessionId>',
      'Delete a session',
      (yargs) => {
        return yargs
          .positional('sessionId', {
            describe: 'Session ID to delete',
            type: 'string',
            demandOption: true,
          })
          .option('force', {
            alias: 'f',
            describe: 'Force delete even if it is the current session',
            type: 'boolean',
            default: false,
          });
      },
      (argv) => {
        deleteCommand(argv.sessionId as string, argv.force);
      }
    )
    .command(
      'info',
      'Show current session information',
      () => {},
      () => {
        infoCommand();
      }
    )
    .command(
      'skills [name]',
      'List discovered skills or inspect one without calling a model',
      (yargs) => yargs
        .positional('name', { type: 'string', describe: 'Skill name to load' })
        .option('dir', { type: 'string', default: process.cwd(), describe: 'Project directory' })
        .option('resource', { type: 'string', describe: 'Read a relative text resource from the named skill' }),
      (argv) => skillsCommand(argv.dir, argv.name, argv.resource),
    )
    .command('agents [session]', 'Inspect persisted subagent records without calling a model',
      (yargs) => yargs.positional('session', { type: 'string', describe: 'Root session ID; omit to list roots' }),
      (argv) => agentsCommand(argv.session))
    .help()
    .alias('h', 'help')
    .alias('v', 'version')
    .strict();
}
