/** 日志保留天数（含当天） */
export const LOG_RETENTION_DAYS = 7;

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
