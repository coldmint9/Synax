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
    if (inputPath.includes('\0')) this.deny('null_byte', inputPath, null, workspaceRoot, sessionId, toolId, 'Path contains null byte.');
    const resolved = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(workspaceRoot, inputPath);
    let realPath = resolved;
    if (config.resolveSymlinks) realPath = this.resolveReal(resolved);
    if (config.unrestricted) return realPath;

    let normalizedRoot = path.resolve(workspaceRoot);
    if (config.resolveSymlinks) {
      try { normalizedRoot = fs.realpathSync(normalizedRoot); } catch { /* keep as-is */ }
    }
    const roots = [normalizedRoot, ...(config.workspaceRoots ?? []).map(root => {
      try { return config.resolveSymlinks ? fs.realpathSync(root) : path.resolve(root); } catch { return path.resolve(root); }
    })];
    const containingRoot = roots.find(root => realPath === root || realPath.startsWith(root + path.sep));
    if (!containingRoot) {
      const kind: SandboxViolationKind = config.resolveSymlinks && realPath !== resolved ? 'symlink_escape' : 'boundary_escape';
      this.deny(kind, inputPath, realPath, workspaceRoot, sessionId, toolId, `Path escapes workspace boundary: ${inputPath}`);
    }
    const segments = path.relative(containingRoot!, realPath).split(path.sep).filter(Boolean);
    const ext = path.extname(realPath).toLowerCase();
    if (ext && config.blockedExtensions.has(ext)) this.deny('blocked_extension', inputPath, realPath, workspaceRoot, sessionId, toolId, `Path has blocked extension: ${ext}`);
    if (segments.length > config.maxDepth) this.deny('depth_exceeded', inputPath, realPath, workspaceRoot, sessionId, toolId, `Path depth ${segments.length} exceeds maximum ${config.maxDepth}.`);
    return realPath;
  }

  validateToolArgs(toolId: string, args: unknown, workspaceRoot: string, sessionId: string): void {
    const extractor = PATH_EXTRACTORS[toolId];
    if (!extractor) return;
    for (const p of extractor(args)) this.resolve(p, workspaceRoot, sessionId, toolId);
  }

  private resolveReal(targetPath: string): string {
    try { return fs.realpathSync(targetPath); }
    catch {
      let current = path.dirname(targetPath);
      while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) return targetPath;
        current = parent;
      }
      return path.resolve(fs.realpathSync(current), path.relative(current, targetPath));
    }
  }

  private deny(kind: SandboxViolationKind, requestedPath: string, resolvedPath: string | null, workspaceRoot: string, sessionId: string, toolId: string, message: string): never {
    const violation: SandboxViolation = { kind, requestedPath, resolvedPath, workspaceRoot, sessionId, toolId, message, timestamp: new Date().toISOString() };
    this.audit.record(violation);
    throw new SandboxViolationError(violation);
  }
}

export const sandboxPolicy = new SandboxPolicy();
