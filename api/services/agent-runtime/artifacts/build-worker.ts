/** A literal worker program survives both tsx and the CJS sidecar bundle; never evals user code. */
export const buildWorkerSource = String.raw`
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const esbuild = require(workerData.esbuildPath);
const parse5 = require(workerData.parse5Path);
let nextRequest = 0;
const pending = new Map();
const files = new Map();
const dependencyFiles = new Map();
function isWithin(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function trustedModule(filename) {
  const real = fs.realpathSync(filename);
  if (!isWithin(workerData.modulesRoot, real) || !workerData.packageRoots.some(root => {
    // Nested node_modules packages need their own declared dependency entry.
    return isWithin(root, real) && !path.relative(root, real).split(path.sep).includes('node_modules');
  })) throw Object.assign(new Error('Dependency outside the fixed package graph.'), {code:'UNSUPPORTED_IMPORT'});
  return real;
}
function dependencyIdentity(filename) {
  const real = trustedModule(filename);
  const index = workerData.packageRoots.findIndex(root => isWithin(root, real) && !path.relative(root, real).split(path.sep).includes('node_modules'));
  // Physical paths stay in this map only. Neither comments nor CommonJS wrapper keys
  // receive absolute filesystem identities from esbuild's default file namespace.
  const id = 'package-' + index + '/' + path.relative(workerData.packageRoots[index], real).split(path.sep).join('/');
  dependencyFiles.set(id, real);
  return {path:id, namespace:'dependency'};
}
function fetchFile(importer, reference) {
  return new Promise((resolve, reject) => {
    const id = ++nextRequest;
    pending.set(id, {resolve, reject});
    parentPort.postMessage({type:'read', id, importer, reference});
  });
}
parentPort.on('message', async message => {
  if (message.type === 'file') {
    const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(Object.assign(new Error(message.error.message), {code:message.error.code}));
    else { files.set(message.file.path, message.file); request.resolve(message.file); }
    return;
  }
  if (message.type === 'parse') {
    try { parentPort.postMessage({type:'parsed',id:message.id,document:parse5.parse(message.source)}); }
    catch { parentPort.postMessage({type:'error',id:message.id,code:'INVALID_SOURCE',message:'HTML document could not be parsed within resource limits.'}); }
    return;
  }
  if (message.type !== 'build') return;
  try {
    const entry = message.entry;
    files.set(entry.path, entry);
    const result = await esbuild.build({
      entryPoints: [entry.path], bundle: true, write: false, outdir: '/artifact-output',
      absWorkingDir: workerData.workingDirectory, platform: 'browser', format: message.classic ? 'esm' : 'iife', treeShaking: !message.classic,
      supported: {'top-level-await':false,'import-meta':false},
      target: ['es2022'], jsx: 'automatic', tsconfigRaw: {}, packages: 'bundle',
      sourcemap: false, legalComments: 'inline', charset: 'utf8', minify: false,
      define: {'process.env.NODE_ENV':'"production"'}, conditions: ['browser','production'],
      logLevel: 'silent', logOverride: {'unsupported-dynamic-import':'error', 'unsupported-require-call':'error'},
      plugins: [{name:'snapshot-only', setup(build) {
        build.onResolve({filter:/.*/}, async args => {
          if (args.kind === 'entry-point') return {path:entry.path, namespace:'snapshot'};
          if (args.namespace === 'dependency') {
            const importer = dependencyFiles.get(args.importer);
            if (!importer) throw Object.assign(new Error('Unknown dependency identity.'), {code:'UNSUPPORTED_IMPORT'});
            trustedModule(importer);
            if (/^(?:node:|https?:|file:|data:|\/)/i.test(args.path)) throw Object.assign(new Error('Unsupported dependency import.'), {code:'UNSUPPORTED_IMPORT'});
            // The fixed installed graph uses explicit relative files/default exports.
            // Resolve paths only (never require/execute package code), then validate and
            // virtualize them. No esbuild file namespace, plugins or workspace config.
            let resolved;
            try { resolved = createRequire(importer).resolve(args.path); }
            catch { throw Object.assign(new Error('Fixed dependency import could not be resolved.'), {code:'UNSUPPORTED_IMPORT'}); }
            return dependencyIdentity(resolved);
          }
          if (args.namespace !== 'snapshot') throw Object.assign(new Error('Unexpected module namespace.'), {code:'UNSUPPORTED_IMPORT'});
          if (!args.path.startsWith('.') && args.kind !== 'url-token' && args.kind !== 'import-rule') {
            const allowed = Object.hasOwn(workerData.dependencies, args.path) ? workerData.dependencies[args.path] : undefined;
            if (!allowed) throw Object.assign(new Error('Unsupported import: ' + args.path), {code:'UNSUPPORTED_IMPORT'});
            return dependencyIdentity(allowed);
          }
          if (args.kind === 'url-token' && args.path.startsWith('#')) return {path:args.path, external:true};
          const file = await fetchFile(args.importer, args.path);
          return {path:file.path, namespace:'snapshot'};
        });
        build.onLoad({filter:/.*/, namespace:'snapshot'}, args => {
          const file = files.get(args.path);
          const ext = path.posix.extname(args.path).slice(1).toLowerCase();
          const textLoaders = {js:'js',mjs:'js',jsx:'jsx',ts:'ts',tsx:'tsx',css:'css',json:'json'};
          const loader = textLoaders[ext] || 'dataurl';
          if (file.mediaType === 'text/html') throw Object.assign(new Error('HTML cannot be imported as a module.'), {code:'UNSUPPORTED_IMPORT'});
          return {contents: file.encoding === 'base64' ? Buffer.from(file.content,'base64') : file.content, loader};
        });
        build.onLoad({filter:/.*/, namespace:'dependency'}, args => {
          const filename = dependencyFiles.get(args.path);
          if (!filename) throw Object.assign(new Error('Unknown dependency identity.'), {code:'UNSUPPORTED_IMPORT'});
          const real = trustedModule(filename);
          // No custom configs, loaders or plugins; trusted JS/CSS/JSON only.
          const ext = path.extname(real);
          if (!['.js','.mjs','.cjs','.jsx','.json','.css'].includes(ext)) throw Object.assign(new Error('Unsupported dependency resource.'), {code:'UNSUPPORTED_IMPORT'});
          return {contents:fs.readFileSync(real), loader: ext === '.json' ? 'json' : ext === '.css' ? 'css' : 'jsx'};
        });
        build.onLoad({filter:/.*/, namespace:'file'}, () => { throw Object.assign(new Error('Filesystem module identities are not permitted.'), {code:'UNSUPPORTED_IMPORT'}); });
      }}],
    });
    let js = '', css = '';
    for (const output of result.outputFiles) {
      if (output.path.endsWith('.css')) css += output.text;
      else if (output.path.endsWith('.js')) js += output.text;
    }
    parentPort.postMessage({type:'built', id:message.id, js, css});
  } catch (error) {
    const problems = error.errors || [];
    const code = problems.map(e => e.detail && e.detail.code).find(Boolean) || error.code || 'INVALID_SOURCE';
    const diagnostics = problems.map(e => (e.location ? e.location.file.replace(/^snapshot:/,'') + ':' + e.location.line + ':' + e.location.column + ': ' : '') + e.text).slice(0,10);
    parentPort.postMessage({type:'error', id:message.id, code, message:diagnostics.join('\n') || 'Artifact compilation failed.'});
  }
});
`;
