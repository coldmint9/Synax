export interface SandboxConfig {
  blockedSegments: Set<string>;
  blockedExtensions: Set<string>;
  resolveSymlinks: boolean;
  maxDepth: number;
}

export function defaultSandboxConfig(): SandboxConfig {
  return {
    blockedSegments: new Set(['.env', '.ssh', '.git', 'node_modules', 'dist', 'build']),
    blockedExtensions: new Set(['.key', '.pem', '.p12', '.pfx']),
    resolveSymlinks: true,
    maxDepth: 30,
  };
}
