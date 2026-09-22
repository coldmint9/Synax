let apiOrigin = "";

export function getApiOrigin(): string {
  return apiOrigin;
}

export async function initApiOrigin(): Promise<void> {
  const electronAPI = (window as any).electronAPI;
  if (!electronAPI?.getApiPort) return;

  const port = await electronAPI.getApiPort();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid desktop runtime port");
  }
  apiOrigin = `http://127.0.0.1:${port}`;
}

export function setApiOriginForTests(origin: string): void {
  apiOrigin = origin;
}
