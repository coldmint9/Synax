import { readFileSync } from "node:fs";
import Database from "libsql";
import { expect, it } from "vitest";

it("backfills existing session titles and messages and indexes replacements", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE agent_runtime_sessions (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, result_summary TEXT);
      CREATE TABLE agent_runtime_messages (id TEXT PRIMARY KEY, content TEXT);
      INSERT INTO agent_runtime_sessions VALUES ('s', '历史标题', '历史请求', '旧摘要');
      INSERT INTO agent_runtime_messages VALUES ('m', '历史消息内容');`);
    db.exec(
      readFileSync(
        new URL(
          "../../../db/migrations/0039_session_fulltext_search.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM agent_search_sessions WHERE agent_search_sessions MATCH ?",
        )
        .get('"历史标题"'),
    ).toMatchObject({ n: 1 });
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM agent_search_messages WHERE agent_search_messages MATCH ?",
        )
        .get('"历史消息"'),
    ).toMatchObject({ n: 1 });
    db.exec(
      "INSERT OR REPLACE INTO agent_runtime_sessions VALUES ('s', '更新标题', '请求', '')",
    );
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM agent_search_sessions WHERE agent_search_sessions MATCH ?",
        )
        .get('"历史标题"'),
    ).toMatchObject({ n: 0 });
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM agent_search_sessions WHERE agent_search_sessions MATCH ?",
        )
        .get('"更新标题"'),
    ).toMatchObject({ n: 1 });
  } finally {
    db.close();
  }
});
