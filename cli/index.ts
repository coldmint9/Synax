#!/usr/bin/env node
import { main } from './main.js';
import { exitCodeForError } from '../api/services/agent-runtime/runtime-protocol.js';

main().then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write(`synax: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = exitCodeForError(error);
});
