import { patchFilePaths } from '../tools/patch-format.js';

export const PATH_EXTRACTORS: Record<string, (args: unknown) => string[]> = {
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
};

PATH_EXTRACTORS['verification.run'] = (args: unknown) => [...PATH_EXTRACTORS.bash(args), ...((args as { scope?: string[] })?.scope ?? [])];
