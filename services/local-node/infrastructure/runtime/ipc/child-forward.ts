import type { WikiChildToParentMessage } from './protocol.js';

export function sendToParent(message: WikiChildToParentMessage): boolean {
  if (process.env.SYNAX_WIKI_JOB_CHILD !== '1' || typeof process.send !== 'function') {
    return false;
  }
  process.send(message);
  return true;
}
