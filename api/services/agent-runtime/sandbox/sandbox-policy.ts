import fs from 'node:fs';
import path from 'node:path';
import { SandboxViolationError, type SandboxViolation, type SandboxViolationKind } from './sandbox-errors.js';
import { defaultSandboxConfig, type SandboxConfig } from './sandbox-config.js';
import { SandboxAuditLog, sandboxAuditLog } from './sandbox-audit.js';
import { PATH_EXTRACTORS } from './path-extractors.js';

export class SandboxPolicy {
  constructor(
    private readonly audit: SandboxAuditLog = sandboxAuditLog,
    private readonly configFactory: (sessionId: string) => SandboxConfig = () => defaultSandboxConfig(),
  ) {}

  resolve(inputPath: string, workspaceRoot: string, sessionId: string, toolId: string): string {
    const config = this.configFactory(sessionId);

    // Layer 1: Null byte check
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

    // Layer 5: Blocked segments
    const relative = path.relative(normalizedRoot, realPath);
    const segments = relative.split(path.sep).filter(Boolean);
    for (const seg of segments) {
      if (config.blockedSegments.has(seg)) {
        this.deny('blocked_segment', inputPath, realPath, workspaceRoot, sessionId, toolId,
          `Path contains blocked segment: ${seg}`);
      }
    }

    // Layer 6: Blocked extensions
    const ext = path.extname(realPath).toLowerCase();
    if (ext && config.blockedExtensions.has(ext)) {
      this.deny('blocked_extension', inputPath, realPath, workspaceRoot, sessionId, toolId,
        `Path has blocked extension: ${ext}`);
    }

    // Layer 7: Depth check
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
