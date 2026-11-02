// Exact UI-only translations of mode-switch refusals. Never rewrite the stored
// error or match a substring: an unfamiliar diagnostic must remain intact.
const modeErrors: Readonly<Record<string, string>> = {
  "Modes are only available on primary native Synax sessions.":
    "仅原生 Synax 主会话支持切换模式。",
  "Stop the run and resolve any input form before switching mode.":
    "请先停止运行并处理待填写的表单，再切换模式。",
  "Close or stop the current orchestration before switching mode.":
    "请先结束或停止当前编排，再切换模式。",
  "Mode cannot be switched right now": "当前无法切换模式",
};

export function composerErrorText(message: string, locale: string): string {
  return locale === "zh" && Object.prototype.hasOwnProperty.call(modeErrors, message)
    ? modeErrors[message]!
    : message;
}
