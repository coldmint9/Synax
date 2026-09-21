import { createHash } from 'node:crypto';
import { parse, parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';
import { ArtifactError, type ArtifactFile } from './contracts.js';
import type { SnapshotReader } from './snapshot.js';

export const POLICY_VERSION = 1;
export const COMPILER_VERSION = 1;
export const SDK_VERSION = 1;
type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
const fail = (message: string): never => { throw new ArtifactError('POLICY_BLOCKED', message); };
function walk(node: Node, visit: (element: Element) => void): void {
  const pending: Array<{node:Node;depth:number}> = [{node,depth:0}]; let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > 10000 || current.depth > 128) throw new ArtifactError('RESOURCE_LIMIT', 'HTML/SVG structure complexity limit exceeded.');
    if ('tagName' in current.node) {
      if (current.node.attrs.length > 128) throw new ArtifactError('RESOURCE_LIMIT', 'HTML attribute count limit exceeded.');
      visit(current.node);
    }
    if ('content' in current.node) pending.push({node:(current.node as DefaultTreeAdapterMap['template']).content,depth:current.depth+1});
    if ('childNodes' in current.node) for (const child of [...current.node.childNodes].reverse()) pending.push({node:child,depth:current.depth+1});
  }
}
function get(element: Element, name: string): string | undefined { return element.attrs.find(attr => attr.name === name)?.value; }
function set(element: Element, name: string, value: string): void {
  const attr = element.attrs.find(a => a.name === name); if (attr) attr.value = value; else element.attrs.push({ name, value });
}
function text(element: Element): string { return element.childNodes.map(child => 'value' in child ? child.value : '').join(''); }
function denyAttributes(element: Element): void {
  for (const attr of element.attrs) {
    const name = attr.name.toLowerCase();
    if (name.startsWith('on') || ['srcdoc', 'nonce', 'integrity', 'ping', 'formaction', 'action', 'manifest', 'background', 'download', 'is'].includes(name)) fail(`Attribute ${name} is not permitted.`);
  }
}
export function validateResource(file: ArtifactFile): void {
  if (file.mediaType === 'image/svg+xml') {
    if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(file.content)) fail('SVG declarations are not allowed.');
    if ((file.content.match(/</g)?.length ?? 0) > 2000) throw new ArtifactError('RESOURCE_LIMIT', 'SVG complexity limit exceeded.');
    const document = parseFragment(file.content);
    let svg = false;
    walk(document, node => {
      svg ||= node.tagName === 'svg';
      if (['script', 'foreignObject', 'iframe', 'object', 'embed', 'style', 'animate', 'animateMotion', 'animateTransform', 'set', 'image', 'use'].includes(node.tagName)) fail('Active or externally-referencing SVG is not allowed.');
      denyAttributes(node);
      for (const attr of node.attrs) if (attr.name === 'style' || (['href','src'].includes(attr.name) && !attr.value.startsWith('#')) || /url\s*\(/i.test(attr.value) && !/^url\(#[\w-]+\)$/.test(attr.value)) fail('SVG external references are not allowed.');
    });
    if (!svg) fail('Invalid SVG image.');
  }
  if (file.encoding === 'base64') {
    const b = Buffer.from(file.content, 'base64');
    const valid = file.mediaType === 'image/png' ? b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : file.mediaType === 'image/jpeg' ? b[0] === 255 && b[1] === 216 && b[2] === 255
      : file.mediaType === 'image/gif' ? /^GIF8[79]a$/.test(b.subarray(0,6).toString())
      : file.mediaType === 'image/webp' ? b.subarray(0,4).toString() === 'RIFF' && b.subarray(8,12).toString() === 'WEBP'
      : file.mediaType === 'image/avif' ? b.subarray(4,8).toString() === 'ftyp' && ['avif','avis'].includes(b.subarray(8,12).toString())
      : file.mediaType === 'image/x-icon' ? b.subarray(0,4).equals(Buffer.from([0,0,1,0]))
      : file.mediaType === 'font/woff' ? b.subarray(0,4).toString() === 'wOFF'
      : file.mediaType === 'font/woff2' && b.subarray(0,4).toString() === 'wOF2';
    if (!valid) fail('Asset bytes do not match the declared image or font type.');
  }
}
function dataUrl(file: ArtifactFile): string {
  validateResource(file);
  if (!file.mediaType.startsWith('image/') && !file.mediaType.startsWith('font/')) fail('Unsupported embedded resource type.');
  return `data:${file.mediaType};base64,${file.encoding === 'base64' ? file.content : Buffer.from(file.content).toString('base64')}`;
}
export type Compile = (file: ArtifactFile, options?: { classic?: boolean }) => Promise<{ js: string; css: string }>;
function hashToken(source: string): string { return `'sha256-${createHash('sha256').update(source).digest('base64')}'`; }
export function runtimeDocument(body: string, scripts: string[], styles: string[], sdk: string): string {
  // All executable text is parser-owned and hashed after HTML end-tag escaping.
  const safeScripts = [sdk, ...scripts].map(source => source.replace(/<\/script/gi, '<\\/script'));
  const safeStyles = styles.map(source => source.replace(/<\/style/gi, '<\\/style'));
  const csp = ["default-src 'none'", `script-src ${safeScripts.map(hashToken).join(' ')}`, "script-src-attr 'none'", `style-src ${safeStyles.map(hashToken).join(' ') || "'none'"}`, "style-src-attr 'none'", 'img-src data: blob:', 'font-src data:', "connect-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "media-src 'none'", "manifest-src 'none'"] .join('; ');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1">${safeStyles.map(s => `<style>${s}</style>`).join('')}<script>${safeScripts[0]}</script></head><body>${body}${safeScripts.slice(1).map(s => `<script>${s}</script>`).join('')}</body></html>`;
}

/** Parse and reconstruct, never concatenate untrusted markup around CSP or bootstrap. */
export async function compileHtml(snapshot: SnapshotReader, compile: Compile, sdk: string, parseHtml: (source: string) => Promise<DefaultTreeAdapterMap['document']> = async source => parse(source)): Promise<string> {
  const entry = snapshot.read(snapshot.entry);
  if (entry.mediaType !== 'text/html') throw new ArtifactError('INVALID_SOURCE', 'HTML entry must be an HTML file.');
  const document = await parseHtml(entry.content);
  const elements: Element[] = [];
  walk(document, node => elements.push(node));
  const scripts: string[] = [], styles: string[] = [];
  let synthetic = 0;
  for (const node of elements) {
    const tag = node.tagName.toLowerCase();
    if (['iframe','frame','frameset','object','embed','base','form','portal','fencedframe','foreignobject','animate','animatemotion','animatetransform','set','noscript','plaintext','xmp','noembed'].includes(tag)) fail(`Element ${tag} is not permitted.`);
    denyAttributes(node);
    if (tag === 'meta' && get(node, 'http-equiv')) fail('Source-controlled HTTP metadata is not permitted.');
    if (tag === 'meta' && get(node, 'charset') && get(node, 'charset')!.toLowerCase() !== 'utf-8') fail('Only UTF-8 source documents are supported.');
    const remove = () => { if (node.parentNode) node.parentNode.childNodes = node.parentNode.childNodes.filter(child => child !== node); };
    if (tag === 'script') {
      const type = get(node, 'type');
      if (type === 'application/json' || type === 'application/ld+json') { if (get(node, 'src')) fail('External data scripts are not permitted.'); continue; }
      if (type && !['module','text/javascript','application/javascript'].includes(type)) fail('Unsupported script type.');
      const src = get(node, 'src');
      const file = src ? snapshot.resolve(entry.path, src) : { path: entry.path + `.inline-${synthetic++}.js`, content: text(node), encoding: 'utf8' as const, mediaType: 'text/javascript' };
      if (!/\.(?:m?js|jsx|ts|tsx)$/i.test(file.path)) fail('Script source must be a JavaScript or TypeScript module.');
      const result = await compile(file, { classic: type !== 'module' }); scripts.push(result.js); if (result.css) styles.push(result.css); remove(); continue;
    }
    if (tag === 'style' || (tag === 'link' && get(node, 'rel')?.toLowerCase() === 'stylesheet')) {
      const href = get(node, 'href');
      if (tag === 'link' && !href) fail('Stylesheet link requires a local resource.');
      const file = href ? snapshot.resolve(entry.path, href) : { path: entry.path + `.inline-${synthetic++}.css`, content: text(node), encoding: 'utf8' as const, mediaType: 'text/css' };
      if (file.mediaType !== 'text/css') fail('Stylesheet must be CSS.');
      const result = await compile(file); styles.push(result.css); remove(); continue;
    }
    if (tag === 'link') fail('Only local stylesheet links are supported.');
    for (const attr of node.attrs) {
      const name = attr.name.toLowerCase();
      if (name === 'style') {
        // esbuild parses CSS escapes/comments and resolves every url(), including @import.
        const className = `synax-inline-${synthetic++}`;
        const result = await compile({ path: entry.path + `.inline-${synthetic++}.css`, content: `.${className}{${attr.value}}`, encoding: 'utf8', mediaType: 'text/css' });
        styles.push(result.css);
        node.attrs = node.attrs.filter(a => a !== attr);
        set(node, 'class', [get(node, 'class'), className].filter(Boolean).join(' '));
      }
      if (['srcset', 'imagesrcset', 'archive', 'codebase', 'data', 'profile'].includes(name)) fail(`Attribute ${name} is not supported.`);
      if (['src', 'poster', 'href'].includes(name)) {
        if (name === 'href' && attr.value.startsWith('#')) continue;
        if (tag === 'a' || tag === 'area') fail('External navigation links are not permitted.');
        if (!(name === 'src' && tag === 'img') && name !== 'poster' && !(name === 'href' && ['image', 'use'].includes(tag))) fail('Unsupported resource attribute.');
        set(node, attr.name, dataUrl(snapshot.resolve(entry.path, attr.value)));
      }
    }
  }
  // Keep both head presentation nodes and body markup, but discard source metadata.
  const head = elements.find(e => e.tagName === 'head')!;
  const body = elements.find(e => e.tagName === 'body')!;
  head.childNodes = head.childNodes.filter(child => !('tagName' in child) || !['meta','title'].includes(child.tagName));
  return runtimeDocument(serialize(head) + serialize(body), scripts, styles, sdk);
}
