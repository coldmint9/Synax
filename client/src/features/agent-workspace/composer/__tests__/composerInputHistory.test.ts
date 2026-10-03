import { beforeEach, describe, expect, it } from "vitest";
import {
  COMPOSER_HISTORY_LIMIT,
  EMPTY_HISTORY_CURSOR,
  clearComposerHistory,
  composerHistoryScope,
  readComposerHistory,
  recallComposerInput,
  recordComposerInput,
  type ComposerHistoryCursor,
} from "../composerInputHistory";

const scope = composerHistoryScope("project-a", "session-1");

beforeEach(() => clearComposerHistory());

describe("composer input history store", () => {
  it("keeps scopes apart and gives drafts their own list", () => {
    expect(composerHistoryScope("project-a", null)).toBe("project-a:draft");
    recordComposerInput(scope, "hello");
    recordComposerInput(composerHistoryScope("project-a", null), "draft text");
    expect(readComposerHistory(scope)).toEqual(["hello"]);
    expect(
      readComposerHistory(composerHistoryScope("project-b", "session-1")),
    ).toEqual([]);
  });

  it("stores the newest entry first and trims it", () => {
    recordComposerInput(scope, "  first  ");
    recordComposerInput(scope, "second");
    expect(readComposerHistory(scope)).toEqual(["second", "first"]);
  });

  it("skips blank submits and repeats of the newest entry", () => {
    recordComposerInput(scope, "only");
    recordComposerInput(scope, "   ");
    recordComposerInput(scope, "only");
    expect(readComposerHistory(scope)).toEqual(["only"]);
    recordComposerInput(scope, "only again");
    expect(readComposerHistory(scope)).toEqual(["only again", "only"]);
    // Only the newest entry is compared, so an older repeat stays in the list.
    recordComposerInput(scope, "only");
    expect(readComposerHistory(scope)).toEqual(["only", "only again", "only"]);
  });

  it("caps the history at the configured limit", () => {
    for (let index = 0; index < COMPOSER_HISTORY_LIMIT + 5; index += 1)
      recordComposerInput(scope, `entry-${index}`);
    const history = readComposerHistory(scope);
    expect(history).toHaveLength(COMPOSER_HISTORY_LIMIT);
    expect(history[0]).toBe(`entry-${COMPOSER_HISTORY_LIMIT + 4}`);
    expect(history).not.toContain("entry-0");
  });
});

describe("composer input recall walk", () => {
  const history = ["third", "second", "first"];

  const walk = (
    steps: Array<-1 | 1>,
    current = "draft",
    cursor: ComposerHistoryCursor = EMPTY_HISTORY_CURSOR,
  ) =>
    steps.reduce<{ content: string; cursor: ComposerHistoryCursor }>(
      (state, direction) => {
        const next = recallComposerInput(
          history,
          state.cursor,
          direction,
          state.content,
        );
        return next ?? state;
      },
      { content: current, cursor },
    );

  it("walks to older entries and stops at the oldest", () => {
    expect(walk([-1])).toEqual({
      content: "third",
      cursor: { index: 0, draft: "draft" },
    });
    expect(walk([-1, -1, -1])).toEqual({
      content: "first",
      cursor: { index: 2, draft: "draft" },
    });
    expect(
      recallComposerInput(history, { index: 2, draft: "draft" }, -1, "first"),
    ).toBeNull();
  });

  it("walks back and restores the stashed draft", () => {
    expect(walk([-1, -1, 1]).content).toBe("third");
    const restored = walk([-1, -1, -1, 1, 1, 1]);
    expect(restored).toEqual({ content: "draft", cursor: EMPTY_HISTORY_CURSOR });
  });

  it("keeps the draft stashed after the recalled text was edited", () => {
    const edited = walk([-1], "draft");
    expect(
      recallComposerInput(history, edited.cursor, 1, "third!"),
    ).toEqual({ content: "draft", cursor: EMPTY_HISTORY_CURSOR });
  });

  it("stays native without history and when walking down from the draft", () => {
    expect(recallComposerInput([], EMPTY_HISTORY_CURSOR, -1, "draft")).toBeNull();
    expect(recallComposerInput([], EMPTY_HISTORY_CURSOR, 1, "draft")).toBeNull();
    expect(recallComposerInput(history, EMPTY_HISTORY_CURSOR, 1, "draft")).toBeNull();
  });
});
