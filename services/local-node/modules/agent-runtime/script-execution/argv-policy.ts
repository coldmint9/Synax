import type { BashInvocation } from '../tools/bash-command-policy.js';

// These executables have no program-execution or output-file options. Do not
// basename arbitrary executable paths: ./cat is project code, not a known read.
const READ_COMMANDS = new Set([
  'cat', 'head', 'tail', 'ls', 'wc', 'grep', 'tr', 'cut',
  'echo', 'printf', 'basename', 'dirname', 'pwd', 'id', 'uname', 'du',
]);
const GIT_READ_OPTIONS = new Set([
  '--stat', '--numstat', '--shortstat', '--name-only', '--name-status',
  '--cached', '--staged', '--check', '--quiet', '--exit-code', '--raw',
  '--patch', '-p', '--no-patch', '-s', '--summary', '--compact-summary',
  '--no-ext-diff', '--no-textconv', '--no-renames', '--relative',
  '--short', '--porcelain', '--branch', '-b', '-z', '--',
]);
const GIT_READ_SUBCOMMANDS = new Set(['diff', 'status', 'ls-files', 'ls-tree', 'rev-parse']);
const FIND_READ_OPTIONS = new Set([
  '-H', '-L', '-P', '-name', '-iname', '-path', '-ipath', '-type',
  '-maxdepth', '-mindepth', '-depth', '-empty', '-size', '-mtime', '-mmin',
  '-atime', '-amin', '-ctime', '-cmin', '-newer', '-print', '-print0',
  '-prune', '-true', '-false', '-a', '-and', '-o', '-or', '-not',
]);

/** Classify exactly one argv invocation. Never shell-parse, expand or join tokens.
 * Unknown executables/options stay write; this is a risk classification, not a
 * filesystem sandbox or proof that PATH/configuration cannot execute code.
 */
export function classifyArgv(argv: readonly string[]): BashInvocation {
  const command = argv[0] || '*';
  let subcommand: string | null = null;
  let risk: BashInvocation['risk'] = 'write';
  if (!argv.length || argv.some(token => typeof token !== 'string' || token.includes('\0')))
    return { command, subcommand, pattern: command, risk };
  const args = argv.slice(1);
  if (READ_COMMANDS.has(command)) risk = 'read';
  if (command === 'rg' && !args.some(arg =>
    /^--(?:pre|hostname-bin)(?:=|$)/.test(arg))) risk = 'read';
  // find can execute programs and write arbitrary output; only recognized
  // predicates are read. Unknown flags (including platform extensions) fail closed.
  if (command === 'find' && args.every(arg => !arg.startsWith('-') || FIND_READ_OPTIONS.has(arg)))
    risk = 'read';
  if (command === 'git') {
    let index = 0;
    while (['--no-pager', '--no-optional-locks', '-C'].includes(args[index])) {
      if (args[index] === '-C') {
        if (!args[index + 1]) break;
        index += 2;
      } else index++;
    }
    // Never skip unknown global flags: -c, --exec-path and config-env can
    // change execution. Aliases, branch and tag remain write, even bare forms.
    subcommand = args[index] && !args[index].startsWith('-') ? args[index] : null;
    const options = args.slice(index + 1);
    if (subcommand && GIT_READ_SUBCOMMANDS.has(subcommand) && options.every(arg =>
      !arg.startsWith('-') || GIT_READ_OPTIONS.has(arg))) risk = 'read';
  }
  return { command, subcommand, pattern: subcommand ? `${command}:${subcommand}` : command, risk };
}
