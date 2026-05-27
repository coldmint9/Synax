interface PickResult {
  path: string
  name: string
}

const electronAPI = (window as any).electronAPI as
  | { showOpenDialog: (opts: any) => Promise<{ canceled: boolean; filePaths: string[] }> }
  | undefined

export const isElectron = !!electronAPI?.showOpenDialog

export async function openDirectoryPicker(): Promise<PickResult | null> {
  if (!electronAPI?.showOpenDialog) return null

  const result = await electronAPI.showOpenDialog({
    properties: ['openDirectory'],
  })

  if (result.canceled || !result.filePaths.length) return null

  const fullPath = result.filePaths[0]
  const segments = fullPath.replace(/\\/g, '/').split('/').filter(Boolean)
  const name = segments[segments.length - 1] || 'Project'

  return { path: fullPath, name }
}
