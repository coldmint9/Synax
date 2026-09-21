import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { resolveInstalledPackage } from '../dependencies.js';
import { isPathWithin } from '../paths.js';
let root: string, modulesRoot: string;
beforeEach(() => { root=fs.mkdtempSync(path.join(os.tmpdir(),'artifact-deps-')); modulesRoot=path.join(root,'node_modules'); fs.mkdirSync(modulesRoot); });
afterEach(() => fs.rmSync(root,{recursive:true,force:true}));
function fixture(name='fixed',version='7.9.0') {
  const folder=path.join(modulesRoot,name); fs.mkdirSync(path.join(folder,'dist'),{recursive:true});
  fs.writeFileSync(path.join(folder,'package.json'),JSON.stringify({name,version,license:'MIT',exports:'./dist/index.js'}));
  fs.writeFileSync(path.join(folder,'dist/package.json'),'{"type":"commonjs"}');
  fs.writeFileSync(path.join(folder,'dist/index.js'),'exports.ok=true');
  fs.writeFileSync(path.join(folder,'LICENSE'),'Test license'); return folder;
}
it('finds metadata by walking the entry even when package.json is not exported', () => {
  const folder=fixture(); const resolver=createRequire(path.join(root,'consumer.cjs'));
  expect(()=>resolver.resolve('fixed/package.json')).toThrow();
  const pkg=resolveInstalledPackage(resolver.resolve('fixed'),'fixed',modulesRoot,'7.9.0');
  expect(pkg.root).toBe(fs.realpathSync(folder)); expect(pkg.metadata.version).toBe('7.9.0'); expect(pkg.licenseText).toBe('Test license');
});
it('rejects mismatched pinned versions and package identity', () => {
  const folder=fixture('fixed','8.0.0');
  expect(()=>resolveInstalledPackage(path.join(folder,'dist/index.js'),'fixed',modulesRoot,'7.9.0')).toThrow(/7\.9\.0/);
  expect(()=>resolveInstalledPackage(path.join(folder,'dist/index.js'),'other',modulesRoot)).toThrow();
});
it('rejects entry, manifest and license symlinks outside the trusted package tree', () => {
  const folder=fixture(); const entry=path.join(folder,'dist/index.js');
  const outside=path.join(root,'outside.js'); fs.writeFileSync(outside,'export const secret=1');
  fs.symlinkSync(outside,path.join(folder,'escape.js')); expect(()=>resolveInstalledPackage(path.join(folder,'escape.js'),'fixed',modulesRoot)).toThrow();
  fs.writeFileSync(path.join(root,'outside.json'),'{"name":"fixed","version":"7.9.0"}');
  fs.unlinkSync(path.join(folder,'package.json')); fs.symlinkSync(path.join(root,'outside.json'),path.join(folder,'package.json'));
  expect(()=>resolveInstalledPackage(entry,'fixed',modulesRoot)).toThrow();
  fs.unlinkSync(path.join(folder,'package.json')); fs.writeFileSync(path.join(folder,'package.json'),'{"name":"fixed","version":"7.9.0"}');
  fs.unlinkSync(path.join(folder,'LICENSE')); fs.symlinkSync(outside,path.join(folder,'LICENSE'));
  expect(()=>resolveInstalledPackage(entry,'fixed',modulesRoot)).toThrow();
});
it('handles Windows drive/UNC containment without treating colon as a source filename', () => {
  expect(isPathWithin('C:\\','C:\\workspace\\index.html',path.win32)).toBe(true);
  expect(isPathWithin('C:\\Work','c:\\work\\index.html',path.win32)).toBe(true);
  expect(isPathWithin('C:\\Work','C:\\Worker\\index.html',path.win32)).toBe(false);
  expect(isPathWithin('C:\\Work','D:\\Work\\index.html',path.win32)).toBe(false);
  const unc='\\\\wsl.localhost\\Ubuntu\\home\\mint\\project';
  expect(isPathWithin(unc,unc+'\\src\\index.html',path.win32)).toBe(true);
  expect(isPathWithin(unc,unc+'\\..\\secret',path.win32)).toBe(false);
  expect(isPathWithin(unc,'\\\\wsl.localhost\\Debian\\home\\mint\\project\\index.html',path.win32)).toBe(false);
});
