import fs from 'node:fs';
import path from 'node:path';
import { SandboxViolationError, type SandboxViolation, type SandboxViolationKind } from './sandbox-errors.js';
import { sandboxConfigForSession, type SandboxConfig } from './sandbox-config.js';
import { SandboxAuditLog, sandboxAuditLog } from './sandbox-audit.js';
import { PATH_EXTRACTORS } from './path-extractors.js';

export class SandboxPolicy {
  constructor(
    private readonly audit: SandboxAuditLog = sandboxAuditLog,
    private readonly configFactory: (sessionId: string) => SandboxConfig = (sessionId) => sandboxConfigForSession(sessionId),
  ) {}

  resolve(inputPath: string, workspaceRoot: string, sessionId: string, toolId: string): string {
    const config = this.configFactory(sessionId);

    // Layer 1: Null byte check — an invalid filesystem input, not a policy rule.
    if (inputPath.includes('\0')) {
      this.deny('null_byte', inputPath, null, workspaceRoot, sessionId, toolId, 'Path contains null byte.');
    }

    // Layer 2: Path resolution
    const resolved = path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(workspaceRoot, inputPath);

    // Layer 3: Symlink resolution
    let realPath = resolved;
    if (config.resolveSymlinks) {
      realPath = this.resolveReal(resolved);
    }

    // Unrestricted sessions release every remaining rule: no workspace boundary,
    // no blocked extensions, no depth ceiling.
    if (config.unrestricted) return realPath;

    // Layer 4: Boundary check
    let normalizedRoot = path.resolve(workspaceRoot);
    if (config.resolveSymlinks) {
      try { normalizedRoot = fs.realpathSync(normalizedRoot); } catch { /* keep as-is */ }
    }
    if (realPath !== normalizedRoot && !realPath.startsWith(normalizedRoot + path.sep)) {
      const kind: SandboxViolationKind = config.resolveSymlinks && realPath !== resolved
        ? 'symlink_escape'
        : 'boundary_escape';
      this.deny(kind, inputPath, realPath, workspaceRoot, sessionId, toolId,
        `Path escapes workspace boundary: ${inputPath}`);
    }

    const segments = path.relative(normalizedRoot, realPath).split(path.sep).filter(Boolean);

    // Layer 5: Blocked extensions
    const ext = path.extname(realPath).toLowerCase();
    if (ext && config.blockedExtensions.has(ext)) {
      this.deny('blocked_extension', inputPath, realPath, workspaceRoot, sessionId, toolId,
        `Path has blocked extension: ${ext}`);
    }

    // Layer 6: Depth check
    if (segments.length > config.maxDepth) {
      this.deny('depth_exceeded', inputPath, realPath, workspaceRoot, sessionId, toolId,
        `Path depth ${segments.length} exceeds maximum ${config.maxDepth}.`);
    }

    return realPath;
  }

  validateToolArgs(toolId: string, args: unknown, workspaceRoot: string, sessionId: string): void {
    const extractor = PATH_EXTRACTORS[toolId];
    if (!extractor) return;
    const paths = extractor(args);
    for (const p of paths) {
      this.resolve(p, workspaceRoot, sessionId, toolId);
    }
  }

  private resolveReal(targetPath: string): string {
    try {
      return fs.realpathSync(targetPath);
    } catch {
      // File doesn't exist yet (write operation) — resolve nearest existing ancestor
      let current = path.dirname(targetPath);
      while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) return targetPath;
        current = parent;
      }
      const realAncestor = fs.realpathSync(current);
      const remainder = path.relative(current, targetPath);
      return path.resolve(realAncestor, remainder);
    }
  }

  private deny(
    kind: SandboxViolationKind,
    requestedPath: string,
    resolvedPath: string | null,
    workspaceRoot: string,
    sessionId: string,
    toolId: string,
    message: string,
  ): never {
    const violation: SandboxViolation = {
      kind, requestedPath, resolvedPath, workspaceRoot,
      sessionId, toolId, message,
      timestamp: new Date().toISOString(),
    };
    this.audit.record(violation);
    throw new SandboxViolationError(violation);
  }
}

export const sandboxPolicy = new SandboxPolicy();
