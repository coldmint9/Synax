import { remoteCatalogItems, remoteExtensionSources } from './remote-source.js';
import { toolRegistry } from '../agent-runtime/tool-registry.js';
import { skillRegistry } from '../skills/skill-registry.js';
import { skillSourceService } from '../skills/skill-source-service.js';
import { getProjectSettings } from '../../lib/config/project-settings-store.js';
import { extensionStore } from './extension-store.js';
import { localExtensionSource } from './local-source.js';
import type {
  ExtensionItem,
  ExtensionKind,
  ExtensionList,
  ExtensionSource,
} from './types.js';
import type { SkillSummary } from '../skills/types.js';
import type { McpServerConfig } from '../../lib/config/config-types.js';

export function mcpIdentity(server: McpServerConfig): string {
  return JSON.stringify([
    server.transport ?? 'stdio',
    server.url ?? '',
    server.command,
    server.args ?? [],
    Object.entries(server.env ?? {}).sort(),
    server.cwd ?? '',
    Object.entries(server.headers ?? {}).sort(),
  ]);
}
export function extensionSources(): ExtensionSource[] {
  return [
    {
      id: 'builtin',
      name: 'Synax',
      description: 'Built-in tools and skills',
      kind: 'builtin',
    },
    {
      id: 'local',
      name: 'Local',
      description: 'Local tools, skills and MCP configurations',
      kind: 'local',
    },
    {
      id: 'custom',
      name: 'Custom',
      description: 'Extensions you create',
      kind: 'custom',
    },
    ...remoteExtensionSources().map((source) => ({
      id: source.id,
      name: source.name,
      description: source.url,
      kind: 'remote' as const,
      editable: true,
    })),
    ...skillSourceService
      .listSources()
      .filter((source) =>
        ['skills-sh', 'well-known', 'git-index'].includes(source.type),
      )
      .map((source) => ({
        id: source.id,
        name: source.label,
        description: source.config.repo ?? source.config.url ?? 'skills.sh',
        kind: 'remote' as const,
        editable: !source.readOnly,
      })),
  ];
}
function skillItem(skill: SkillSummary): ExtensionItem {
  return {
    id: skill.installationId ?? skill.id,
    kind: 'skill',
    name: skill.label,
    description: skill.description,
    sourceId:
      skill.sourceKind === 'builtin'
        ? 'builtin'
        : skill.sourceId === 'custom'
          ? 'custom'
          : ['local', 'project'].includes(skill.sourceId) ||
              skill.sourceKind === 'project'
            ? 'local'
            : skill.sourceId,
    sourceLabel: skill.sourceKind === 'builtin' ? 'Synax' : skill.sourceId,
    installed: Boolean(skill.installed),
    enabled: Boolean(skill.installed) && skill.status !== 'disabled',
    version: skill.version,
    permissions: skill.requiredCapabilities,
    detail: skill.installPath,
    locator: {
      sourceId: skill.sourceId,
      name: skill.name,
      remoteUrl: skill.remoteUrl,
    },
  };
}
export function installedCatalog(projectId: string): ExtensionItem[] {
  const definitions = extensionStore.definitions(projectId);
  const items: ExtensionItem[] = toolRegistry
    .list()
    .filter((tool) => tool.id !== 'tools.invalid')
    .map((tool) => ({
      id: tool.id,
      kind: 'tool',
      name: tool.label,
      description: tool.description,
      sourceId: 'builtin',
      sourceLabel: 'Synax',
      installed: true,
      enabled: true,
      permissions: [tool.internalGate ?? tool.category],
      detail: tool.id,
    }));
  items.push(
    ...skillRegistry
      .listSummaries({
        projectId,
        includeDisabled: true,
        includeUnmounted: true,
      })
      .map(skillItem),
  );
  items.push(
    ...getProjectSettings(projectId, true).mcpServers.map((server) => ({
      id: server.id,
      kind: 'mcp' as const,
      name: server.name,
      description:
        server.transport === 'http'
          ? (server.url ?? '')
          : [server.command, ...(server.args ?? [])].join(' '),
      sourceId: 'local',
      sourceLabel: 'MCP',
      installed: true,
      enabled: server.enabled !== false,
      editable: true,
      permissions: ['mcp'],
    })),
  );
  for (const definition of definitions) {
    const existing = items.findIndex(
      (item) => item.kind === definition.kind && item.id === definition.id,
    );
    const item: ExtensionItem = {
      ...(existing >= 0 ? items[existing] : {}),
      id: definition.id,
      kind: definition.kind,
      name: definition.name,
      description: definition.description,
      sourceId: definition.sourceId,
      sourceLabel:
        definition.sourceId === 'custom'
          ? 'Custom'
          : definition.sourceId === 'local'
            ? 'Local'
            : (remoteExtensionSources().find(
                (source) => source.id === definition.sourceId,
              )?.name ?? definition.sourceId),
      version: definition.version,
      installed: true,
      enabled: true,
      editable: definition.sourceId === 'custom' || definition.kind === 'mcp',
      permissions:
        definition.kind === 'tool'
          ? [definition.tool?.mode === 'http' ? 'network' : 'shell']
          : [definition.kind],
    };
    if (existing >= 0) items[existing] = item;
    else items.push(item);
  }
  const unique = new Map(
    items.map((item) => [`${item.kind}:${item.id}`, item]),
  );
  return [...unique.values()].map((item) => ({
    ...item,
    ...extensionStore.state(projectId, item.kind, item.id, item),
  }));
}
export async function listExtensions(
  projectId: string,
  query: {
    view?: 'installed' | 'market';
    kind?: ExtensionKind;
    source?: string;
    q?: string;
    offset?: number;
    limit?: number;
  },
): Promise<ExtensionList> {
  const warnings: string[] = [];
  const installed = installedCatalog(projectId);
  let items = [...installed];
  const market = query.view === 'market';
  if (market) {
    for (const item of remoteCatalogItems(projectId))
      if (
        !items.some(
          (current) => current.kind === item.kind && current.id === item.id,
        )
      )
        items.push(item);
  }
  if (market && (!query.source || query.source === 'local')) {
    try {
      const local = localExtensionSource(projectId);
      warnings.push(
        ...local.warnings,
        ...local.locations
          .filter((location) => location.status === 'error')
          .map((location) => `${location.path}: ${location.message}`),
        ...local.mcp.unsupported.map((item) => `${item.name}: ${item.reason}`),
      );
      const servers = getProjectSettings(projectId, true).mcpServers;
      for (const found of local.mcp.servers) {
        const existing = servers.find(
          (server) => mcpIdentity(server) === mcpIdentity(found.server),
        );
        const id = existing?.id ?? `local-${found.fingerprint.slice(0, 20)}`;
        if (items.some((item) => item.kind === 'mcp' && item.id === id))
          continue;
        items.push({
          id,
          kind: 'mcp',
          name: found.server.name,
          description: found.sources.map((source) => source.client).join(' · '),
          sourceId: 'local',
          sourceLabel: 'Local',
          installed: false,
          enabled: false,
          locator: {
            sourceId: 'local',
            name: found.server.name,
            discoveryId: found.fingerprint,
          },
        });
      }
      for (const found of local.skills) {
        const id = found.installed
          ? `project/${found.name}`
          : `discovered/${found.id}`;
        if (items.some((item) => item.kind === 'skill' && item.id === id))
          continue;
        items.push({
          id,
          kind: 'skill',
          name: found.name,
          description: found.description,
          sourceId: 'local',
          sourceLabel: 'Local',
          installed: false,
          enabled: false,
          conflict: found.conflict
            ? 'A different skill with this name already exists in this project.'
            : undefined,
          locator: {
            sourceId: 'local',
            name: found.name,
            discoveryId: found.id,
          },
        });
      }
      for (const found of local.tools) {
        if (!items.some((item) => item.kind === 'tool' && item.id === found.id))
          items.push({
            id: found.id,
            kind: 'tool',
            name: found.definition.name,
            description: found.definition.description,
            sourceId: 'local',
            sourceLabel: 'Local',
            installed: false,
            enabled: false,
            locator: {
              sourceId: 'local',
              name: found.definition.name,
              discoveryId: found.id,
            },
          });
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  const liveSource = market
    ? skillSourceService
        .listSources()
        .find(
          (source) =>
            source.enabled &&
            source.type === 'skills-sh' &&
            (query.source
              ? source.id === query.source
              : source.id === 'default-remote'),
        )
    : undefined;
  if (liveSource)
    items = items.filter(
      (item) => item.kind !== 'skill' || item.sourceId !== liveSource.id,
    );
  const q = query.q?.trim().toLowerCase();
  items = items.filter(
    (item) =>
      (market || item.installed) &&
      (!query.kind || item.kind === query.kind) &&
      (!query.source || item.sourceId === query.source) &&
      (!q ||
        `${item.name} ${item.description} ${item.id}`
          .toLowerCase()
          .includes(q)),
  );
  items.sort((a, b) => a.name.localeCompare(b.name));
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 30;
  const page = items.slice(offset, offset + limit);
  let total = items.length;
  let totalExact = true;
  let hasMore = offset + page.length < total;
  if (liveSource && (!query.kind || query.kind === 'skill')) {
    try {
      // Selecting an exact source avoids catalog winner precedence hiding its results.
      const remote = await skillRegistry.listWithTotal({
        projectId,
        includeDisabled: true,
        includeUnmounted: true,
        sourceId: liveSource.id,
        q: query.q,
        offset: Math.max(0, offset - items.length),
        limit: Math.max(1, limit - page.length),
      });
      const mapped = remote.items.map(skillItem).map((item) => {
        const existing = installed.find(
          (entry) => entry.kind === 'skill' && entry.id === item.id,
        );
        return {
          ...item,
          ...(existing
            ? { installed: existing.installed, enabled: existing.enabled }
            : {}),
          ...extensionStore.state(projectId, 'skill', item.id, item),
        };
      });
      if (page.length < limit)
        page.push(
          ...mapped
            .filter(
              (item) =>
                !page.some(
                  (other) => other.kind === item.kind && other.id === item.id,
                ),
            )
            .slice(0, limit - page.length),
        );
      total += remote.total;
      totalExact = remote.totalExact === true;
      hasMore =
        offset + limit < items.length ||
        remote.hasMore ||
        (page.length >= limit && offset + limit < total);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { items: page, total, totalExact, hasMore, warnings };
}
