import fs from 'node:fs';
import type { ToolCallRecord } from './contracts.js';
import { resolveWorkspacePath, toWorkspaceRelative } from './tools/workspace.js';

interface ReadRecord {
  mtimeMs: number;
}

const sessionReads = new Map<string, Map<string, ReadRecord>>();

const BASH_READ_COMMANDS = new Set(['cat', 'head', 'tail', 'sed', 'grep', 'egrep', 'fgrep']);

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function sessionMap(sessionId: string): Map<string, ReadRecord> {
  let reads = sessionReads.get(sessionId);
  if (!reads) {
    reads = new Map();
    sessionReads.set(sessionId, reads);
  }
  return reads;
}

function looksLikeFilePath(token: string): boolean {
  if (!token || token.startsWith('-')) return false;
  return token.includes('/') || token.includes('.') || /^[\w.-]+$/.test(token);
}

/** Paths viewed via allowed single-file bash commands (no pipes/redirects). */
export function extractBashReadPaths(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed || /[|&;<>]/.test(trimmed)) return [];

  const tokens = trimmed.split(/\s+/);
  const commandName = tokens[0]?.replace(/^.*\//, '').toLowerCase() ?? '';
  if (!BASH_READ_COMMANDS.has(commandName)) return [];

  const fileTokens: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('-')) continue;
    if (commandName === 'sed' && !looksLikeFilePath(token)) continue;
    if (looksLikeFilePath(token)) fileTokens.push(token);
  }

  if (fileTokens.length === 0) return [];
  return [fileTokens[fileTokens.length - 1]!];
}

export function recordSessionFileRead(sessionId: string, workspaceRelativePath: string): void {
  const normalized = normalizePath(workspaceRelativePath);
  const filePath = resolveWorkspacePath(normalized, sessionId);
  if (!fs.existsSync(filePath)) return;
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return;
  sessionMap(sessionId).set(normalized, { mtimeMs: stat.mtimeMs });
}

export function recordBashFileReads(sessionId: string, command: string, exitCode: number | null): void {
  if (exitCode !== 0) return;
  for (const path of extractBashReadPaths(command)) {
    try {
      recordSessionFileRead(sessionId, path);
    } catch {
      // Ignore paths outside workspace or missing files.
    }
  }
}

export function assertSessionFileReadForWrite(sessionId: string, workspaceRelativePath: string): void {
  const normalized = normalizePath(workspaceRelativePath);
  const filePath = resolveWorkspacePath(normalized, sessionId);
  if (!fs.existsSync(filePath)) return;

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return;

  const record = sessionMap(sessionId).get(normalized);
  if (!record) {
    throw new Error(`File "${normalized}" was not read in this session. Call file.read first.`);
  }
  if (stat.mtimeMs !== record.mtimeMs) {
    throw new Error(`File "${normalized}" changed on disk since last read. Call file.read again before editing.`);
  }
}

export function rebuildSessionFileReads(sessionId: string, toolCalls: ToolCallRecord[]): void {
  sessionReads.set(sessionId, new Map());

  for (const call of toolCalls) {
    if (call.status !== 'completed') continue;

    if (call.toolId === 'file.read') {
      const path = (call.inputRef as { path?: string } | null)?.path;
      if (path) {
        try {
          recordSessionFileRead(sessionId, path);
        } catch {
          // File may have been removed since the read.
        }
      }
      continue;
    }

    if (call.toolId === 'bash') {
      const command = (call.inputRef as { command?: string } | null)?.command;
      const exitCode = (call.outputRef as { exitCode?: number | null } | null)?.exitCode ?? null;
      if (command) recordBashFileReads(sessionId, command, exitCode);
    }
  }
}

/** @internal Test helper */
export function clearSessionFileReads(sessionId: string): void {
  sessionReads.delete(sessionId);
}

/** @internal Test helper */
export function getSessionReadPaths(sessionId: string): string[] {
  return [...(sessionReads.get(sessionId)?.keys() ?? [])];
}
