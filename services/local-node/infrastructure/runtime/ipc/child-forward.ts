import type { ChildToParentMessage } from './protocol.js';

export function sendToParent(message: ChildToParentMessage): boolean {
  if (typeof process.send !== 'function') {
    return false;
  }
  process.send(message);
  return true;
}
