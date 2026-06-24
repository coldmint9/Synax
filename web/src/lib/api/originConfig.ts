let apiOrigin = ''

export function getApiOrigin(): string {
  return apiOrigin
}

export async function initApiOrigin(): Promise<void> {
  const electronAPI = (window as any).electronAPI
  if (!electronAPI?.getApiPort) return

  const port = await electronAPI.getApiPort()
  if (port) {
    apiOrigin = `http://localhost:${port}`
  }
}

export function setApiOriginForTests(origin: string): void {
  apiOrigin = origin
}
