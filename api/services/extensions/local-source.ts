import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { discoverLocalIntegrations } from '../integrations/local-discovery.js';
import {
  resolveProjectWorkDir,
  resolveProjectWorkspaceLocation,
} from '../agent-runtime/tools/workspace.js';
import { workspaceLocationHostPath } from '../workspace-location.js';
import { expandHome } from '../skills/paths.js';
import { extensionStore } from './extension-store.js';
import { customExtensionSchema } from './schemas.js';
import type { CustomExtensionInput } from './types.js';

export function localSourceDirectories(projectId: string): string[] {
  const root = resolveProjectWorkDir(projectId);
  const location = resolveProjectWorkspaceLocation(projectId);
  return extensionStore.directories(projectId).map((directory) => {
    if (location?.kind === 'wsl' && !directory.startsWith('\\\\')) {
      return workspaceLocationHostPath({
        ...location,
        path: path.posix.resolve(location.path, directory),
      });
    }
    return path.resolve(root, expandHome(directory));
  });
}

/** Read declarations only. Discovery never runs a script or starts an MCP server. */
export function localExtensionSource(projectId: string) {
  const root = resolveProjectWorkDir(projectId);
  const directories = localSourceDirectories(projectId);
  const integrations = discoverLocalIntegrations(root, {
    extraDirectories: directories,
  });
  const tools: Array<{
    id: string;
    definition: CustomExtensionInput;
    path: string;
  }> = [];
  const warnings: string[] = [];
  for (const directory of [
    ...new Set([path.join(root, '.synax'), ...directories]),
  ]) {
    const file = path.join(directory, 'synax-tools.json');
    if (!fs.existsSync(file)) continue;
    try {
      if (fs.statSync(file).size > 256 * 1024)
        throw new Error('Tool manifest exceeds 256 KB');
      const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(payload.tools) || payload.tools.length > 100)
        throw new Error('Expected at most 100 tools');
      for (const value of payload.tools) {
        const definition = customExtensionSchema.parse({
          ...value,
          kind: 'tool',
        });
        const id = `custom.local-${createHash('sha256')
          .update(file + ':' + definition.name)
          .digest('hex')
          .slice(0, 16)}`;
        tools.push({ id, definition, path: file });
      }
    } catch (error) {
      warnings.push(
        `${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { ...integrations, tools, warnings };
}
