/** Keep framework stacks, HTTP headers and request credentials in main-process
 * logs, never in renderer state or native dialogs. */
export function updateFailureMessage(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown; statusCode?: unknown } | null;
  const message = typeof value?.message === "string" ? value.message : typeof error === "string" ? error : "";
  const code = typeof value?.code === "string" ? value.code : "";
  const text = `${code} ${message}`;
  if (/ENOSPC|disk.*full|no space left/i.test(text))
    return "磁盘空间不足，更新未完成。请释放空间后重试。";
  if (/EACCES|EPERM|permission denied/i.test(text))
    return "无法写入更新文件。请检查应用与缓存目录的权限后重试。";
  if (/sha512|checksum|校验失败|digest mismatch/i.test(text))
    return "安装包校验失败，已停止安装。请重试以重新下载，或从发布页手动下载安装包。";
  if (/signature|codesign|签名|ERR_UPDATER_INVALID_SIGNATURE/i.test(text))
    return "系统未通过安装包签名验证，更新未完成。请从发布页手动下载安装包。";
  if (/CHANNEL_FILE_NOT_FOUND|\b404\b|清单尚未就绪/i.test(text))
    return "当前平台的更新清单尚未就绪或更新源无法访问。请稍后重试，或从发布页手动下载。";
  if (/\b(401|403)\b/i.test(text))
    return "更新源拒绝访问或请求次数超限。请稍后重试，或在更新网络设置中切换直连／代理。";
  if (/ETIMEDOUT|ECONN|ENOTFOUND|EAI_AGAIN|ERR_NETWORK|net::|fetch failed|timeout|timed out|offline|network|proxy|GitHub.*request failed/i.test(text))
    return "无法连接更新源或下载中断。请检查网络，在更新网络设置中切换直连／代理后重试。";
  // Preserve concise, actionable application errors, but not embedded stacks or URLs with secrets.
  if (/^[\u4e00-\u9fff]/.test(message) && message.length <= 300 && !/[\r\n]|[?&](?:token|key|auth)=/i.test(message))
    return message;
  return "更新未完成。请重试；若仍然失败，可从发布页手动下载。详细原因已记录到应用日志。";
}
