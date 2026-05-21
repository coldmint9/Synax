import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

const DEFAULT_STATE: WindowState = { width: 1400, height: 900 };

export function loadWindowState(): WindowState {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_STATE;
  }
}

export function saveWindowState(state: WindowState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {
    // non-critical
  }
}
