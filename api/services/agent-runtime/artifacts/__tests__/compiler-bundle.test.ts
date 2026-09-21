import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('runs the inline worker and real SDK from a bundled CommonJS sidecar', async () => {
  const folder = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'.bundle-test-'));
  const output = path.join(folder,'compiler.cjs');
  try {
    await build({
      stdin: { contents: `import fs from 'node:fs';import {compileArtifact} from './compiler';import {readSnapshot} from './snapshot';
        (async()=>{fs.writeFileSync(process.argv[2]+'/index.html','<button>Offline bundle</button><script>window.compiled=1</script>');const result=await compileArtifact(readSnapshot(process.argv[2],'index.html'),'html');if(!result.html.includes('synaxWidget')||!result.html.includes('Offline bundle'))throw Error('Missing runtime');console.log('bundle-ok')})().catch(error=>{console.error(error);process.exitCode=1});`, resolveDir: path.dirname(path.dirname(fileURLToPath(import.meta.url))), loader:'ts' },
      outfile: output, platform:'node', format:'cjs', target:'node22', bundle:true, packages:'external', logLevel:'silent',
    });
    expect(execFileSync(process.execPath,[output,folder],{encoding:'utf8',timeout:20000}).trim()).toBe('bundle-ok');
  } finally { fs.rmSync(folder,{recursive:true,force:true}); }
});
