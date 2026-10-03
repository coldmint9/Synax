// Dev-only worker bootstrap: registers tsx loader for .js→.ts resolution in worker threads
import { register } from 'tsx/esm/api';
import { workerData } from 'node:worker_threads';

register();

await import(workerData.__workerPath);
