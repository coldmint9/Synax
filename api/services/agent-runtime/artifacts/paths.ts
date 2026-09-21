import path from 'node:path';

/** Strict descendant check, including drive roots, Windows case aliases and UNC shares. */
export function isPathWithin(root: string, candidate: string, paths: Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'> = path): boolean {
  if (!paths.isAbsolute(root) || !paths.isAbsolute(candidate)) return false;
  const relative = paths.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
}
