export const PATH_EXTRACTORS: Record<string, (args: unknown) => string[]> = {
  'file.read':   (a) => [(a as any)?.path].filter(Boolean),
  'file.write':  (a) => [(a as any)?.path].filter(Boolean),
  'file.patch':  (a) => [(a as any)?.path].filter(Boolean),
  'file.glob':   (a) => [(a as any)?.path ?? '.'].filter(Boolean),
  'file.list':   (a) => [(a as any)?.path ?? '.'].filter(Boolean),
  'grep.search': (a) => [(a as any)?.path ?? '.'].filter(Boolean),
  'diff.read':   (a) => ['.'],
};
