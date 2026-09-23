import { apiRequest } from './origin'
export type {
  ExtensionItem,
  ExtensionKind,
  ExtensionList,
  ExtensionSource,
  ExtensionDefinition,
  CustomExtensionInput,
  CustomToolConfig,
} from '../../../../api/services/extensions/types'
import type {
  ExtensionItem,
  ExtensionKind,
  ExtensionList,
  ExtensionSource,
  ExtensionDefinition,
  CustomExtensionInput,
} from '../../../../api/services/extensions/types'
const base = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/extensions`
const itemPath = (
  projectId: string,
  item: Pick<ExtensionItem, 'kind' | 'id'>,
) => `${base(projectId)}/${item.kind}/${encodeURIComponent(item.id)}`
export const extensionsApi = {
  list(
    projectId: string,
    input: {
      view: 'installed' | 'market'
      kind?: ExtensionKind
      source?: string
      q?: string
      offset?: number
      limit?: number
    },
  ) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(input))
      if (value !== undefined && value !== '') params.set(key, String(value))
    return apiRequest<ExtensionList>(`${base(projectId)}?${params}`)
  },
  sources: (projectId: string) =>
    apiRequest<{ items: ExtensionSource[]; directories: string[] }>(
      `${base(projectId)}/sources`,
    ),
  addSource: (
    projectId: string,
    input: { id: string; name: string; url: string },
  ) =>
    apiRequest(`${base(projectId)}/sources`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  syncSource: (projectId: string, id: string) =>
    apiRequest(`${base(projectId)}/sources/${encodeURIComponent(id)}/sync`, {
      method: 'POST',
    }),
  saveDirectories: (projectId: string, directories: string[]) =>
    apiRequest(`${base(projectId)}/sources/local`, {
      method: 'PUT',
      body: JSON.stringify({ directories }),
    }),
  detail: (projectId: string, item: Pick<ExtensionItem, 'kind' | 'id'>) =>
    apiRequest<{
      item: ExtensionItem
      definition?: ExtensionDefinition
      content?: string
    }>(itemPath(projectId, item)),
  install: (projectId: string, item: ExtensionItem) =>
    apiRequest<{ id: string }>(`${base(projectId)}/install`, {
      method: 'POST',
      body: JSON.stringify({
        kind: item.kind,
        id: item.id,
        locator: item.locator,
      }),
    }),
  changeState: (
    projectId: string,
    item: ExtensionItem,
    action: 'enable' | 'disable' | 'uninstall',
  ) =>
    apiRequest(`${itemPath(projectId, item)}/state`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),
  saveCustom: (projectId: string, input: CustomExtensionInput) =>
    apiRequest<{ definition: ExtensionDefinition }>(
      `${base(projectId)}/custom`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
}
