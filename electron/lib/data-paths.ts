import { app } from 'electron';
import path from 'node:path';

export function getDataRoot(): string {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'data');
  }
  return path.resolve(app.getAppPath(), '.data');
}

export function getResourcePath(...segments: string[]): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...segments);
  }
  return path.resolve(app.getAppPath(), ...segments);
}
