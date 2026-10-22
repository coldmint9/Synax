/** 日志保留天数（含当天） */
export const LOG_RETENTION_DAYS = 7;

/** Local RFC 3339 time with an explicit offset; keep log dates and displayed time aligned. */
export function formatLogTimestamp(date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const absolute = Math.abs(offset);
  return `${formatLocalDay(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

export function formatLocalDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 保留窗口内最早仍有效的日期（YYYY-MM-DD） */
export function retentionCutoffDay(retentionDays = LOG_RETENTION_DAYS, now = new Date()): string {
  const safeDays = Math.max(1, Math.trunc(retentionDays));
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (safeDays - 1));
  return formatLocalDay(cutoff);
}
