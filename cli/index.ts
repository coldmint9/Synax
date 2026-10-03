#!/usr/bin/env node
import { main } from './main.js';
import { exitCodeForError } from '../services/local-node/modules/agent-runtime/runtime-protocol.js';

main().then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write(`synax: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = exitCodeForError(error);
});
