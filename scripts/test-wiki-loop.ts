/**
 * End-to-end test script for wikiLoopService.generate()
 * Run with: bun run scripts/test-wiki-loop.ts
 */
import { wikiLoopService } from '../api/services/wiki/wiki-loop-service.js';

const PROJECT_ID = 'test-Synax';
const WORK_DIR = '.';

async function main() {
  console.log('=== Wiki Loop Service E2E Test ===');
  console.log(`Project: ${PROJECT_ID}`);
  console.log(`WorkDir: ${WORK_DIR}`);
  console.log('');

  try {
    const result = await wikiLoopService.generate({
      projectId: PROJECT_ID,
      workDir: WORK_DIR,
      locale: 'zh',
    });

    console.log('=== Result ===');
    console.log(JSON.stringify(result, null, 2));

    if (result.status === 'failed') {
      console.error('Wiki generation FAILED:', result.error);
      process.exit(1);
    }

    console.log('Wiki generation completed successfully!');
  } catch (err) {
    console.error('Unhandled error:', err);
    process.exit(1);
  }
}

main();
