import path from 'node:path';
import { patchFilePaths } from '../tools/patch-format.js';

/** Conservative argv operands, resolved from the declared cwd, not the process
 * cwd. False-positive operands are preferable to missing extensionless paths.
 * Script source, stdin and script arguments are never interpreted as filenames.
 */
function runPaths(value: unknown): string[] {
  const args = value as { workdir?: string; argv?: string[] } | undefined;
  const cwd = args?.workdir ?? '.';
  const paths = [cwd];
  let operandCwd = cwd;
  let operandsOnly = false;
  const relativeToCwd = (operand: string) => {
    // Preserve NUL and home syntax for the sandbox validator to reject/expand.
    if (operand.includes('\0') || operand.startsWith('~') || path.isAbsolute(operand)) return operand;
    return path.join(operandCwd, operand);
  };
  if (!Array.isArray(args?.argv)) return paths;
  for (const [index, token] of args.argv.entries()) {
    if (typeof token !== 'string') continue;
    if (index === 0) {
      if (token.includes('/') || token.includes('\\') || token.includes('\0')) paths.push(relativeToCwd(token));
      continue;
    }
    // After --, even option-shaped tokens name literal operands. Do not strip
    // prefixes or split '=': the full path may itself be a symlink escape.
    if (operandsOnly) {
      paths.push(relativeToCwd(token));
      continue;
    }
    // Git's -C options compose, including multiple relative -C directories.
    if (args.argv[0] === 'git' && (args.argv[index - 1] === '-C' || /^-C.+/.test(token))) {
      operandCwd = relativeToCwd(token.startsWith('-C') ? token.slice(2) : token);
      paths.push(operandCwd);
      continue;
    }
    if (token === '--') {
      operandsOnly = true;
      continue;
    }
    if (!token.startsWith('-')) paths.push(relativeToCwd(token));
    else {
      const equals = token.indexOf('=');
      if (equals >= 0) paths.push(relativeToCwd(token.slice(equals + 1)));
      else if (/^-[CIof].+/.test(token)) paths.push(relativeToCwd(token.slice(2)));
    }
  }
  return paths;
}

export const PATH_EXTRACTORS: Record<string, (args: unknown) => string[]> = {
  'run': runPaths,
  'file.read':   (a) => [(a as any)?.path].filter(Boolean),
  'file.write':  (a) => [(a as any)?.path].filter(Boolean),
  edit: (a) => [(a as any)?.path].filter(Boolean),
  'file.patch':  (a) => patchFilePaths((a as any)?.patch),
  'file.delete': (a) => [(a as any)?.path].filter(Boolean),
  'rg': (a) => [(a as any)?.path ?? '.'].filter(Boolean),
  'file.list': (a) => [(a as any)?.path ?? '.'].filter(Boolean),
  'diff.read':   (a) => ['.'],
  'bash':        (a) => {
    const args = a as any;
    const paths: string[] = [];
    if (args?.workdir) paths.push(args.workdir);
    if (typeof args?.command === 'string') {
      const regex = /(?:^|\s)(?:'([^']+)'|"([^"]+)"|([^\s-][^\s]*))/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(args.command)) !== null) {
        const path = match[1] ?? match[2] ?? match[3];
        if (path && (path.includes('/') || path.includes('.') || path.includes('~') || path.includes('*'))) {
          paths.push(path);
        }
      }
    }
    return paths;
  },
  // Arbitrary code may touch anything the workspace contains, so only the
  // declared working directory can be validated up front. guard.py enforces the
  // boundary for every path the script actually opens.
  'python.run':  (a) => [(a as any)?.workdir].filter(Boolean),
};

PATH_EXTRACTORS['verification.run'] = (args: unknown) => [...PATH_EXTRACTORS.bash(args), ...((args as { scope?: string[] })?.scope ?? [])];
