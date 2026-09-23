import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { DATA_ROOT } from '../../lib/env.js';
import {
  getProjectSettings,
  patchProjectSettingsSection,
} from '../../lib/config/project-settings-store.js';
import { resolveProjectWorkDir } from '../agent-runtime/tools/workspace.js';
import { skillInstallService } from '../skills/skill-install-service.js';
import { skillRegistry } from '../skills/skill-registry.js';
import { parseSkillFile } from '../skills/skill-parser.js';
import { importDiscoveredSkill } from '../integrations/local-discovery.js';
import { mcpClientManager } from '../mcp/mcp-client-manager.js';
import {
  remoteCatalogDefinition,
  remoteCatalogItems,
} from './remote-source.js';
import { extensionStore } from './extension-store.js';
import { installedCatalog } from './extension-catalog.js';
import {
  localExtensionSource,
  localSourceDirectories,
} from './local-source.js';
import { customExtensionSchema } from './schemas.js';
import type {
  CustomExtensionInput,
  ExtensionDefinition,
  ExtensionItem,
  ExtensionKind,
} from './types.js';

function saveMcp(
  projectId: string,
  definition: ExtensionDefinition,
  installed = true,
  enabled = true,
): void {
  const servers = getProjectSettings(projectId, true).mcpServers.filter(
    (server) => server.id !== definition.id,
  );
  if (installed && definition.mcp)
    servers.push({ ...definition.mcp, id: definition.id, enabled });
  patchProjectSettingsSection(
    projectId,
    'mcp',
    { mcpServers: servers },
    'extension-center',
  );
  mcpClientManager.closeServer(definition.id, projectId);
}
export function saveCustomExtension(
  projectId: string,
  raw: CustomExtensionInput,
  sourceId = 'custom',
): ExtensionDefinition {
  const input = customExtensionSchema.parse(raw);
  const existing = input.id
    ? extensionStore.definition(projectId, input.kind, input.id)
    : undefined;
  const configuredMcp =
    input.id && input.kind === 'mcp'
      ? getProjectSettings(projectId, true).mcpServers.find(
          (server) => server.id === input.id,
        )
      : undefined;
  if (
    input.id &&
    !existing &&
    !configuredMcp &&
    sourceId !== 'local' &&
    !sourceId.startsWith('catalog/')
  )
    throw new Error('Custom extension not found');
  if (
    existing &&
    existing.sourceId !== 'custom' &&
    input.kind !== 'mcp' &&
    sourceId !== 'local' &&
    !sourceId.startsWith('catalog/')
  )
    throw new Error(
      'This source owns the extension. Create a custom copy to edit it.',
    );
  const token = randomUUID().slice(0, 12);
  const id =
    input.id ??
    (input.kind === 'tool'
      ? `custom.${token}`
      : input.kind === 'skill'
        ? `custom/${token}`
        : `custom-${token}`);
  const definition: ExtensionDefinition = {
    id,
    kind: input.kind,
    name: input.name,
    description: input.description,
    sourceId: existing?.sourceId ?? sourceId,
  };
  if (input.kind === 'tool') {
    z.fromJSONSchema(input.tool!.inputSchema);
    definition.tool = input.tool;
  } else if (input.kind === 'skill') {
    // Managed content lives outside the project: no overwriting checked-in or imported skills.
    const projectKey = createHash('sha256').update(projectId).digest('hex');
    const skillKey = createHash('sha256').update(id).digest('hex');
    const dir = path.join(DATA_ROOT, 'extensions', projectKey, skillKey);
    fs.mkdirSync(dir, { recursive: true });
    const staged = path.join(dir, `SKILL-${randomUUID()}.md`);
    const content = input.content!.startsWith('---')
      ? input.content!
      : `---\nname: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(input.description)}\n---\n\n${input.content}`;
    try {
      fs.writeFileSync(staged, content);
      const parsed = parseSkillFile(staged);
      definition.version = parsed.version;
      definition.skillPath = path.join(dir, 'SKILL.md');
      fs.renameSync(staged, definition.skillPath);
    } finally {
      fs.rmSync(staged, { force: true });
    }
  } else {
    definition.mcp = { ...input.mcp!, id, name: input.name };
  }
  const state =
    existing || configuredMcp
      ? extensionStore.state(projectId, input.kind, id, {
          installed: true,
          enabled: configuredMcp?.enabled !== false,
        })
      : { installed: true, enabled: true };
  if (definition.kind === 'mcp')
    saveMcp(projectId, definition, state.installed, state.enabled);
  extensionStore.save(projectId, definition);
  extensionStore.setState(projectId, input.kind, id, state);
  return definition;
}
export function extensionDetail(
  projectId: string,
  kind: ExtensionKind,
  id: string,
) {
  const item = [
    ...installedCatalog(projectId),
    ...remoteCatalogItems(projectId),
  ].find((item) => item.kind === kind && item.id === id);
  if (!item) throw new Error('Extension not found');
  let definition = extensionStore.definition(projectId, kind, id);
  if (!definition && kind === 'mcp') {
    const mcp = getProjectSettings(projectId, true).mcpServers.find(
      (server) => server.id === id,
    );
    if (mcp)
      definition = {
        id,
        kind,
        name: mcp.name,
        description: item.description,
        sourceId: 'local',
        mcp,
      };
  }
  let content: string | undefined;
  const catalog = remoteCatalogDefinition(id);
  if (catalog && !item.installed)
    return {
      item,
      content: catalog.definition.content,
      definition: { ...catalog.definition, id, sourceId: catalog.sourceId },
    };
  if (kind === 'skill') {
    const skill = skillRegistry.getSummary(id, projectId, true, true);
    if (skill.installPath) content = fs.readFileSync(skill.installPath, 'utf8');
  }
  return { item, definition, content };
}
export async function installExtension(
  projectId: string,
  input: {
    kind: ExtensionKind;
    id: string;
    locator?: ExtensionItem['locator'];
  },
): Promise<string> {
  const current = installedCatalog(projectId).find(
    (item) => item.kind === input.kind && item.id === input.id,
  );
  let id = input.id;
  const catalog = remoteCatalogDefinition(id);
  if (catalog && !current) {
    if (catalog.definition.kind !== input.kind)
      throw new Error('Extension type mismatch');
    const definition = saveCustomExtension(
      projectId,
      { ...catalog.definition, id },
      catalog.sourceId,
    );
    if (catalog.version)
      extensionStore.save(projectId, {
        ...definition,
        version: catalog.version,
      });
    return id;
  }
  if (
    current &&
    (current.installed ||
      !current.locator?.remoteUrl ||
      extensionStore.definition(projectId, input.kind, input.id))
  ) {
    const definition = extensionStore.definition(projectId, input.kind, id);
    if (definition?.kind === 'mcp') saveMcp(projectId, definition);
  } else if (input.locator?.discoveryId) {
    const local = localExtensionSource(projectId);
    const discoveryId = input.locator.discoveryId;
    if (input.kind === 'skill') {
      const skill = local.skills.find((item) => item.id === discoveryId);
      if (!skill)
        throw new Error(
          'This local skill is no longer available. Refresh the source.',
        );
      if (skill.conflict)
        throw new Error('A different skill already uses this name');
      const imported = skill.installed
        ? { id: `project/${skill.name}` }
        : importDiscoveredSkill(resolveProjectWorkDir(projectId), discoveryId, {
            extraDirectories: localSourceDirectories(projectId),
          });
      id = imported.id;
    } else if (input.kind === 'mcp') {
      const found = local.mcp.servers.find(
        (item) => item.fingerprint === discoveryId,
      );
      if (!found)
        throw new Error('This MCP configuration is no longer available');
      id = `local-${found.fingerprint.slice(0, 20)}`;
      const definition: ExtensionDefinition = {
        id,
        kind: 'mcp',
        name: found.server.name,
        description: found.sources.map((source) => source.client).join(' · '),
        sourceId: 'local',
        mcp: { ...found.server, id },
      };
      saveMcp(projectId, definition);
      extensionStore.save(projectId, definition);
    } else {
      const found = local.tools.find((item) => item.id === discoveryId);
      if (!found) throw new Error('This tool manifest is no longer available');
      id = saveCustomExtension(
        projectId,
        { ...found.definition, id: found.id },
        'local',
      ).id;
    }
  } else if (input.kind === 'skill' && input.locator?.remoteUrl) {
    const { sourceId, name, remoteUrl } = input.locator;
    const installed = skillInstallService
      .listInstalls()
      .find((item) => item.sourceId === sourceId && item.name === name);
    id =
      installed?.id ??
      (await skillInstallService.install({ sourceId, name, remoteUrl })).id;
    if (!installed) extensionStore.registerSkillPackage(id);
  } else
    throw new Error(
      'Extension not found. Refresh the catalog before installing.',
    );
  extensionStore.setState(projectId, input.kind, id, {
    installed: true,
    enabled: true,
  });
  return id;
}
export function changeExtensionState(
  projectId: string,
  kind: ExtensionKind,
  id: string,
  action: 'enable' | 'disable' | 'uninstall',
): void {
  const item = installedCatalog(projectId).find(
    (item) => item.kind === kind && item.id === id,
  );
  if (!item?.installed) throw new Error('Install the extension first');
  const state = {
    installed: action !== 'uninstall',
    enabled: action === 'enable',
  };
  if (kind === 'mcp') {
    let definition = extensionStore.definition(projectId, kind, id);
    if (!definition) {
      const mcp = getProjectSettings(projectId, true).mcpServers.find(
        (server) => server.id === id,
      );
      if (!mcp) throw new Error('MCP configuration not found');
      definition = {
        id,
        kind,
        name: mcp.name,
        description: item.description,
        sourceId: 'local',
        mcp,
      };
      extensionStore.save(projectId, definition);
    }
    saveMcp(projectId, definition, state.installed, state.enabled);
  }
  extensionStore.setState(projectId, kind, id, state);
}
