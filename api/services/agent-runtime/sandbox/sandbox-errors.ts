import { AgentPermissionError } from '../runtime-errors.js';

export type SandboxViolationKind =
  | 'boundary_escape'
  | 'symlink_escape'
  | 'blocked_segment'
  | 'blocked_extension'
  | 'depth_exceeded'
  | 'null_byte';

export interface SandboxViolation {
  kind: SandboxViolationKind;
  requestedPath: string;
  resolvedPath: string | null;
  workspaceRoot: string;
  sessionId: string;
  toolId: string;
  message: string;
  timestamp: string;
}

export class SandboxViolationError extends AgentPermissionError {
  public readonly violation: SandboxViolation;
  public override readonly code: string;

  constructor(violation: SandboxViolation) {
    super(violation.message, 403);
    this.name = 'SandboxViolationError';
    this.code = 'SANDBOX_VIOLATION';
    this.violation = violation;
  }
}
