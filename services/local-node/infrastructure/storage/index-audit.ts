import type NativeDatabase from "libsql";

export interface IndexAuditEntry {
  table: string;
  name: string;
  unique: boolean;
  origin: string;
  partial: boolean;
  columns: string[];
}

export interface DuplicateIndexGroup {
  table: string;
  columns: string[];
  indexes: string[];
  redundantIndexes: string[];
}

export interface IndexAuditReport {
  indexes: IndexAuditEntry[];
  duplicateGroups: DuplicateIndexGroup[];
}

interface IndexListRow {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface IndexInfoRow {
  seqno: number;
  name: string | null;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function listTables(db: NativeDatabase.Database): string[] {
  return (db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>).map((row) => row.name);
}

function listIndexes(db: NativeDatabase.Database, table: string): IndexAuditEntry[] {
  const rows = db
    .prepare(`PRAGMA index_list(${quoteIdentifier(table)})`)
    .all() as IndexListRow[];

  return rows.map((row) => {
    const columns = (db
      .prepare(`PRAGMA index_info(${quoteIdentifier(row.name)})`)
      .all() as IndexInfoRow[])
      .sort((a, b) => a.seqno - b.seqno)
      .map((column) => column.name ?? "<expression>");

    return {
      table,
      name: row.name,
      unique: row.unique === 1,
      origin: row.origin,
      partial: row.partial === 1,
      columns,
    };
  });
}

/**
 * Finds exact duplicate index definitions. A non-unique index with the same
 * table and columns as a unique index is normally redundant: the unique index
 * already provides the same lookup order while also enforcing the constraint.
 *
 * This is intentionally an audit only. It never drops an index automatically.
 */
export function auditIndexes(
  db: NativeDatabase.Database,
  tables = listTables(db),
): IndexAuditReport {
  const indexes = tables.flatMap((table) => listIndexes(db, table));
  const groups = new Map<string, IndexAuditEntry[]>();

  for (const index of indexes) {
    const key = `${index.table}\u0000${index.columns.join("\u0000")}`;
    const group = groups.get(key) ?? [];
    group.push(index);
    groups.set(key, group);
  }

  const duplicateGroups: DuplicateIndexGroup[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const hasUnique = group.some((index) => index.unique);
    duplicateGroups.push({
      table: group[0].table,
      columns: group[0].columns,
      indexes: group.map((index) => index.name),
      redundantIndexes: hasUnique
        ? group.filter((index) => !index.unique).map((index) => index.name)
        : [],
    });
  }

  return { indexes, duplicateGroups };
}
