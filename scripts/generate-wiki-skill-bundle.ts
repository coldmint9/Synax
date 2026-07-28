import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import {
  renderWikiAuthoringBundle,
  WIKI_AUTHORING_BUNDLE_PATH,
  WIKI_AUTHORING_SKILL_PATH,
} from '../api/services/wiki/wiki-authoring-codegen.js';

const raw = readFileSync(WIKI_AUTHORING_SKILL_PATH, 'utf8');
const rendered = renderWikiAuthoringBundle(raw);

mkdirSync(dirname(WIKI_AUTHORING_BUNDLE_PATH), { recursive: true });
writeFileSync(WIKI_AUTHORING_BUNDLE_PATH, rendered, 'utf8');

console.log(`  generated ${relative(process.cwd(), WIKI_AUTHORING_BUNDLE_PATH)}`);
