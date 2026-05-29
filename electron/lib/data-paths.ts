import { app } from 'electron';
import path from 'node:path';

export function getDataRoot(): string {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'data');
  }
  return path.join(app.getPath('home'), '.synax');
}

export function getResourcePath(...segments: string[]): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...segments);
  }
  return path.resolve(app.getAppPath(), ...segments);
}
