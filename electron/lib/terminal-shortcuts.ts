/** Terminal control keys stay in the PTY, while macOS app/window shortcuts remain available. */
export function isTerminalSystemShortcut(input: { key: string; meta: boolean; control: boolean }, platform = process.platform): boolean {
  if (platform !== 'darwin' || !input.meta) return false;
  const key = input.key.toLowerCase();
  return ['q', 'h', 'm', ','].includes(key) || (input.control && key === 'f');
}
