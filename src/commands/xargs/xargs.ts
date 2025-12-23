import { Command, CommandContext, ExecResult } from '../../types.js';
import { hasHelpFlag, showHelp, unknownOption } from '../help.js';

const xargsHelp = {
  name: 'xargs',
  summary: 'build and execute command lines from standard input',
  usage: 'xargs [OPTION]... [COMMAND [INITIAL-ARGS]]',
  options: [
    '-I REPLACE   replace occurrences of REPLACE with input',
    '-n NUM       use at most NUM arguments per command line',
    '-0, --null   items are separated by null, not whitespace',
    '-t, --verbose  print commands before executing',
    '-r, --no-run-if-empty  do not run command if input is empty',
    '    --help   display this help and exit',
  ],
};

export const xargsCommand: Command = {
  name: 'xargs',

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(xargsHelp);
    }

    let replaceStr: string | null = null;
    let maxArgs: number | null = null;
    let nullSeparator = false;
    let verbose = false;
    let noRunIfEmpty = false;
    let commandStart = 0;

    // Parse xargs options
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-I' && i + 1 < args.length) {
        replaceStr = args[++i];
        commandStart = i + 1;
      } else if (arg === '-n' && i + 1 < args.length) {
        maxArgs = parseInt(args[++i], 10);
        commandStart = i + 1;
      } else if (arg === '-0' || arg === '--null') {
        nullSeparator = true;
        commandStart = i + 1;
      } else if (arg === '-t' || arg === '--verbose') {
        verbose = true;
        commandStart = i + 1;
      } else if (arg === '-r' || arg === '--no-run-if-empty') {
        noRunIfEmpty = true;
        commandStart = i + 1;
      } else if (arg.startsWith('--')) {
        return unknownOption('xargs', arg);
      } else if (arg.startsWith('-') && arg.length > 1) {
        // Check for unknown short options
        let valid = true;
        for (const c of arg.slice(1)) {
          if (!'0trnI'.includes(c)) {
            return unknownOption('xargs', `-${c}`);
          }
        }
        // Handle combined short options
        if (arg.includes('0')) nullSeparator = true;
        if (arg.includes('t')) verbose = true;
        if (arg.includes('r')) noRunIfEmpty = true;
        commandStart = i + 1;
      } else if (!arg.startsWith('-')) {
        commandStart = i;
        break;
      }
    }

    // Get command and initial args
    const command = args.slice(commandStart);
    if (command.length === 0) {
      command.push('echo');
    }

    // Parse input
    const separator = nullSeparator ? '\0' : /\s+/;
    const items = ctx.stdin
      .split(separator)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    if (items.length === 0) {
      if (noRunIfEmpty) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      // With no -r flag, still run the command with no args
      // (echo with no args just outputs newline)
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    // Execute commands
    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    // Helper to execute a single command via the shell
    const executeCommand = async (cmdArgs: string[]): Promise<ExecResult> => {
      // Build the command string for execution
      const cmdLine = cmdArgs.join(' ');
      if (verbose) {
        stderr += cmdLine + '\n';
      }
      // Use ctx.exec to run the command
      if (ctx.exec) {
        return ctx.exec(cmdLine);
      }
      // Fallback: just output what would be run
      return { stdout: cmdLine + '\n', stderr: '', exitCode: 0 };
    };

    if (replaceStr !== null) {
      // -I mode: run command once per item, replacing replaceStr in each argument
      for (const item of items) {
        const cmdArgs = command.map(c => c.replaceAll(replaceStr, item));
        const result = await executeCommand(cmdArgs);
        stdout += result.stdout;
        stderr += result.stderr;
        if (result.exitCode !== 0) {
          exitCode = result.exitCode;
        }
      }
    } else if (maxArgs !== null) {
      // -n mode: batch items
      for (let i = 0; i < items.length; i += maxArgs) {
        const batch = items.slice(i, i + maxArgs);
        const cmdArgs = [...command, ...batch];
        const result = await executeCommand(cmdArgs);
        stdout += result.stdout;
        stderr += result.stderr;
        if (result.exitCode !== 0) {
          exitCode = result.exitCode;
        }
      }
    } else {
      // Default: all items on one line
      const cmdArgs = [...command, ...items];
      const result = await executeCommand(cmdArgs);
      stdout += result.stdout;
      stderr += result.stderr;
      exitCode = result.exitCode;
    }

    return { stdout, stderr, exitCode };
  },
};
