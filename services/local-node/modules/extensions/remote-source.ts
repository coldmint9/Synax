import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { businessStore as store } from '../../infrastructure/persistence/business-store.js';
import { fetchSkillText } from '../skills/skill-http.js';
import { customExtensionSchema } from './schemas.js';
import type { CustomExtensionInput, ExtensionItem } from './types.js';
import { extensionStore } from './extension-store.js';
interface SourceRow {
  id: string;
  name: string;
  url: string;
  catalog_json: string;
}
interface CatalogEntry {
  id: string;
  version?: string;
  definition: CustomExtensionInput;
}
export function remoteExtensionSources() {
  return store.list<SourceRow>('extension-sources').sort((a,b)=>a.name.localeCompare(b.name)).map(({id,name,url})=>({id,name,url}));
}
export async function saveRemoteSource(input: {
  id: string;
  name: string;
  url: string;
}) {
  const id = input.id.startsWith('catalog/') ? input.id : `catalog/${input.id}`;
  // Fetch a bounded document. Parsing/installation never executes catalog code.
  const manifest = JSON.parse(await fetchSkillText(input.url));
  const parsed = z
    .object({
      extensions: z
        .array(
          z.object({
            id: z.string().min(1).max(128),
            version: z.string().max(64).optional(),
            definition: customExtensionSchema,
          }),
        )
        .max(200),
    })
    .parse(manifest);
  const keys = new Set<string>();
  const entries: CatalogEntry[] = parsed.extensions.map((entry) => {
    if (keys.has(entry.id))
      throw new Error('Duplicate extension id in catalog');
    keys.add(entry.id);
    const token = createHash('sha256')
      .update(`${id}:${entry.id}`)
      .digest('hex')
      .slice(0, 20);
    const kind = entry.definition.kind;
    return {
      ...entry,
      id:
        kind === 'tool'
          ? `custom.market-${token}`
          : kind === 'skill'
            ? `custom/${token}`
            : `market-${token}`,
      definition: { ...entry.definition, id: undefined },
    };
  });
  store.put('extension-sources',id,{id,name:input.name,url:input.url,catalog_json:JSON.stringify(entries)});
  await store.flush(['extension-sources']);
  return { id, count: entries.length };
}
export async function syncRemoteSource(id: string) {
  const source = remoteExtensionSources().find((source) => source.id === id);
  if (!source) throw new Error('Source not found');
  return saveRemoteSource(source);
}
export function remoteCatalogDefinition(id: string) {
  const sources = store.list<SourceRow>('extension-sources');
  for (const source of sources) {
    const entry = (JSON.parse(source.catalog_json) as CatalogEntry[]).find(
      (entry) => entry.id === id,
    );
    if (entry)
      return { ...entry, sourceId: source.id, sourceName: source.name };
  }
}
export function remoteCatalogItems(projectId: string): ExtensionItem[] {
  const sources = store.list<SourceRow>('extension-sources');
  return sources.flatMap((source) =>
    (JSON.parse(source.catalog_json) as CatalogEntry[]).map((entry) => ({
      id: entry.id,
      kind: entry.definition.kind,
      name: entry.definition.name,
      description: entry.definition.description,
      version: entry.version,
      sourceId: source.id,
      sourceLabel: source.name,
      ...extensionStore.state(projectId, entry.definition.kind, entry.id, {
        installed: false,
        enabled: false,
      }),
      permissions: [
        entry.definition.kind === 'tool'
          ? entry.definition.tool?.mode === 'http'
            ? 'network'
            : 'shell'
          : entry.definition.kind,
      ],
    })),
  );
}
