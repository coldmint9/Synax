export function buildTreeString(files: string[], root: string, maxDepth: number): string {
  const tree: Record<string, { files: string[]; dirs: Set<string> }> = {};
  for (const filePath of files) {
    const rel = root ? filePath.slice(root.length).replace(/^\//, '') : filePath;
    const parts = rel.split('/');
    for (let depth = 0; depth < Math.min(parts.length, maxDepth); depth++) {
      const dir = parts.slice(0, depth + 1).join('/');
      const parent = depth === 0 ? '.' : parts.slice(0, depth).join('/');
      if (!tree[parent]) tree[parent] = { files: [], dirs: new Set() };
      if (depth + 1 < parts.length) {
        tree[parent].dirs.add(dir);
      } else {
        tree[parent].files.push(parts[parts.length - 1]);
      }
    }
  }
  const lines: string[] = [];
  const render = (dir: string, prefix: string, depth: number) => {
    const node = tree[dir];
    if (!node) return;
    const entries: Array<{ name: string; isDir: boolean }> = [];
    for (const d of node.dirs) entries.push({ name: d.split('/').pop()!, isDir: true });
    for (const f of node.files) entries.push({ name: f, isDir: false });
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    for (let i = 0; i < entries.length; i++) {
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const entry = entries[i];
      if (entry.isDir) {
        const fullDir = dir === '.' ? entry.name : `${dir}/${entry.name}`;
        const childCount = files.filter(f => {
          const r = root ? f.slice(root.length).replace(/^\//, '') : f;
          return r.startsWith(fullDir + '/') || r === fullDir;
        }).length;
        lines.push(`${prefix}${connector}${entry.name}/ (${childCount} files)`);
        if (depth + 1 < maxDepth) {
          render(fullDir, prefix + (isLast ? '    ' : '│   '), depth + 1);
        }
      } else {
        lines.push(`${prefix}${connector}${entry.name}`);
      }
    }
  };
  const rootLabel = root || '.';
  lines.push(`${rootLabel}/`);
  render('.', '', 0);
  return lines.join('\n');
}
