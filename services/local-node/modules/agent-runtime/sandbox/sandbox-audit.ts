import type { SandboxViolation } from './sandbox-errors.js';

export class SandboxAuditLog {
  private readonly violations: SandboxViolation[] = [];
  private readonly maxRetained = 200;

  record(violation: SandboxViolation): void {
    this.violations.push(violation);
    if (this.violations.length > this.maxRetained) {
      this.violations.splice(0, this.violations.length - this.maxRetained);
    }
  }

  recent(sessionId?: string, limit = 20): SandboxViolation[] {
    const filtered = sessionId
      ? this.violations.filter(v => v.sessionId === sessionId)
      : this.violations;
    return filtered.slice(-limit);
  }

  clear(sessionId?: string): void {
    if (sessionId) {
      const kept = this.violations.filter(v => v.sessionId !== sessionId);
      this.violations.length = 0;
      this.violations.push(...kept);
    } else {
      this.violations.length = 0;
    }
  }
}

export const sandboxAuditLog = new SandboxAuditLog();
