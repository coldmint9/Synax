import type { ToolCallRecord } from "../contracts.js";
// Reserved internal caller identity; persists in both legacy SQL and versioned
// history without introducing a second tool journal or database migration.
const PREFIX = "__synax_code__:";
export function nestedModelCallId(parentId: string, sequence: number): string {
  return `${PREFIX}${parentId}:${sequence}`;
}
export function codeParentId(
  record: Pick<ToolCallRecord, "modelToolCallId">,
): string | undefined {
  const id = record.modelToolCallId;
  if (!id?.startsWith(PREFIX)) return undefined;
  return id.slice(PREFIX.length, id.lastIndexOf(":")) || undefined;
}
export function isCodeNestedCall(
  record: Pick<ToolCallRecord, "modelToolCallId">,
): boolean {
  return Boolean(codeParentId(record));
}
