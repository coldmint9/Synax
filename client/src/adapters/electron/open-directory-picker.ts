interface PickResult {
  path: string
  name: string
}

interface OpenDirectoryPickerOptions {
  multiple?: boolean
}

const electronAPI = (window as any).electronAPI as
  | { showOpenDialog: (opts: any) => Promise<{ canceled: boolean; filePaths: string[] }> }
  | undefined

export const isElectron = !!electronAPI?.showOpenDialog

function toPickResult(fullPath: string): PickResult {
  const segments = fullPath.replace(/\\/g, '/').split('/').filter(Boolean)
  const name = segments[segments.length - 1] || 'Project'

  return { path: fullPath, name }
}

export function openDirectoryPicker(options: { multiple: true }): Promise<PickResult[]>
export function openDirectoryPicker(options?: { multiple?: false }): Promise<PickResult | null>
export async function openDirectoryPicker(
  options: OpenDirectoryPickerOptions = {},
): Promise<PickResult | PickResult[] | null> {
  const multiple = options.multiple === true
  if (!electronAPI?.showOpenDialog) return multiple ? [] : null

  const result = await electronAPI.showOpenDialog({
    properties: multiple ? ['openDirectory', 'multiSelections'] : ['openDirectory'],
  })

  if (result.canceled || !result.filePaths.length) return multiple ? [] : null

  const selections = result.filePaths.map(toPickResult)
  return multiple ? selections : selections[0] ?? null
}
