export function desktopExternalApi() {
  return (window as Window & {
    electronAPI?: { openPortalExternal?: (url: string) => Promise<boolean> };
  }).electronAPI;
}

export async function openExternalUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('不支持的服务地址');
  }
  const api = desktopExternalApi();
  if (api?.openPortalExternal) {
    if (!(await api.openPortalExternal(url))) throw new Error('无法打开浏览器');
  } else window.open(url, '_blank', 'noopener,noreferrer');
}
