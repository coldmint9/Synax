import test from "node:test";
import assert from "node:assert/strict";
import { files, flowReducer, initialState } from "./flow-model.js";

const reduce = (actions, state = initialState) =>
  actions.reduce(flowReducer, state);
const confirmAll = [
  { type: "CONFIRM_FILE", fileId: files[0].id },
  { type: "CONFIRM_FILE", fileId: files[1].id },
];

test("主路径：确认冲突、测试、合并", () => {
  const testing = reduce([...confirmAll, { type: "RUN_TESTS" }]);
  assert.equal(testing.stage, "testing");
  assert.equal(testing.testProgress, 0);

  const ready = reduce([
    ...confirmAll,
    { type: "RUN_TESTS" },
    { type: "TICK_TESTS", amount: 42 },
  ]);
  assert.equal(ready.stage, "ready");
  assert.equal(ready.testProgress, 42);

  const merging = flowReducer(ready, { type: "MERGE" });
  assert.equal(merging.stage, "merging");
  const merged = flowReducer(merging, { type: "MERGE_DONE" });
  assert.equal(merged.stage, "merged");
  assert.match(merged.events.at(-1).text, /合并完成/);
});

test("选择不会直接解决，必须单独确认", () => {
  const chosen = flowReducer(initialState, {
    type: "CHOOSE",
    fileId: "auth",
    choice: "local",
  });
  assert.equal(chosen.choices.auth, "local");
  assert.deepEqual(chosen.confirmed, []);
  assert.equal(flowReducer(chosen, { type: "RUN_TESTS" }).stage, "conflict");
  const confirmed = flowReducer(chosen, {
    type: "CONFIRM_FILE",
    fileId: "auth",
  });
  assert.deepEqual(confirmed.confirmed, ["auth"]);
  const changed = flowReducer(confirmed, {
    type: "CHOOSE",
    fileId: "auth",
    choice: "combined",
  });
  assert.deepEqual(changed.confirmed, []);
  assert.equal(initialState.choices.auth, "combined");
  assert.deepEqual(initialState.confirmed, []);
});

test("未确认全部文件不能开始测试", () => {
  const one = flowReducer(initialState, {
    type: "CONFIRM_FILE",
    fileId: "auth",
  });
  assert.equal(flowReducer(one, { type: "RUN_TESTS" }).stage, "conflict");
  assert.equal(
    flowReducer(initialState, { type: "RUN_TESTS" }).stage,
    "conflict",
  );
});

test("测试失败后可重试，且不会为每个 tick 生成事件", () => {
  const testing = reduce([
    { type: "SET_SIMULATE_FAILURE", value: true },
    ...confirmAll,
    { type: "RUN_TESTS" },
  ]);
  const partial = flowReducer(testing, { type: "TICK_TESTS", amount: 10 });
  assert.deepEqual(partial.events, testing.events);
  let state = reduce(
    [
      { type: "TICK_TESTS", amount: 10 },
      { type: "TICK_TESTS", amount: 22 },
    ],
    partial,
  );
  assert.equal(state.stage, "failed");
  assert.equal(state.testProgress, 42);
  assert.equal(
    state.events.filter((entry) => entry.id.startsWith("tests-failed:")).length,
    1,
  );

  state = flowReducer(state, { type: "SET_SIMULATE_FAILURE", value: false });
  state = flowReducer(state, { type: "RETRY_TESTS" });
  state = flowReducer(state, { type: "TICK_TESTS", amount: 42 });
  assert.equal(state.stage, "ready");
});

test("main 更新会进入 stale，重新扫描后回到冲突阶段", () => {
  const ready = reduce([
    ...confirmAll,
    { type: "RUN_TESTS" },
    { type: "TICK_TESTS", amount: 42 },
  ]);
  const stale = flowReducer(ready, { type: "MERGE_GUARD" });
  assert.equal(stale.stage, "stale");
  assert.equal(stale.revision, 2);
  assert.deepEqual(stale.confirmed, []);
  assert.equal(flowReducer(stale, { type: "MERGE" }), stale);
  assert.equal(flowReducer(stale, { type: "RUN_TESTS" }), stale);
  const scanning = flowReducer(stale, { type: "RESCAN" });
  assert.equal(scanning.stage, "scanning");
  const conflict = flowReducer(scanning, { type: "SCAN_DONE" });
  assert.equal(conflict.stage, "conflict");
  assert.deepEqual(conflict.confirmed, []);
});

test("非法动作保持状态引用和内容不变", () => {
  const state = initialState;
  assert.equal(flowReducer(state, { type: "MERGE" }), state);
  assert.equal(flowReducer(state, { type: "TICK_TESTS", amount: 100 }), state);
  assert.equal(
    flowReducer(state, { type: "CONFIRM_FILE", fileId: "missing" }),
    state,
  );
  assert.equal(
    flowReducer(state, { type: "CHOOSE", fileId: "auth", choice: "other" }),
    state,
  );
});

test("真实重复选择和重新确认追加回执，相同确认双击不追加", () => {
  let state = initialState;
  for (const choice of ["local", "combined", "local"]) {
    const previousCount = state.events.length;
    state = flowReducer(state, { type: "CHOOSE", fileId: "auth", choice });
    assert.equal(state.events.length, previousCount + 1);
    state = flowReducer(state, { type: "CONFIRM_FILE", fileId: "auth" });
    assert.equal(state.events.length, previousCount + 2);
    const confirmed = state;
    state = flowReducer(state, { type: "CONFIRM_FILE", fileId: "auth" });
    assert.equal(state, confirmed);
  }
  assert.equal(
    state.events.filter((entry) => entry.id.startsWith("choice:auth:local:"))
      .length,
    2,
  );
  assert.equal(
    state.events.filter((entry) => entry.id.startsWith("confirmed:auth:"))
      .length,
    3,
  );
  assert.equal(
    new Set(state.events.map((entry) => entry.id)).size,
    state.events.length,
  );
});

test("重试通过、分支过期重扫、再确认和再测试均保留新的事件实例", () => {
  const recovered = reduce([
    { type: "SET_SIMULATE_FAILURE", value: true },
    ...confirmAll,
    { type: "RUN_TESTS" },
    { type: "TICK_TESTS", amount: 42 },
    { type: "SET_SIMULATE_FAILURE", value: false },
    { type: "RETRY_TESTS" },
    { type: "TICK_TESTS", amount: 42 },
  ]);
  const rescanned = reduce(
    [{ type: "MERGE_GUARD" }, { type: "RESCAN" }, { type: "SCAN_DONE" }],
    recovered,
  );
  assert.equal(rescanned.eventSequence, recovered.eventSequence + 3);
  const readyAgain = reduce(
    [...confirmAll, { type: "RUN_TESTS" }, { type: "TICK_TESTS", amount: 42 }],
    rescanned,
  );
  assert.equal(readyAgain.stage, "ready");
  assert.equal(readyAgain.eventSequence, rescanned.eventSequence + 4);
  for (const prefix of [
    "confirmed:auth:",
    "confirmed:middleware:",
    "tests-started:",
    "tests-passed:",
  ]) {
    assert.equal(
      readyAgain.events.filter((entry) => entry.id.startsWith(prefix)).length,
      2,
    );
  }
});

test("事件窗口截断后实例序号仍递增且不碰撞", () => {
  let state = initialState;
  const emitted = new Set(state.events.map((entry) => entry.id));
  for (let index = 0; index < 30; index += 1) {
    const previousSequence = state.eventSequence;
    state = flowReducer(state, {
      type: "CHOOSE",
      fileId: "auth",
      choice: index % 2 === 0 ? "local" : "combined",
    });
    assert.equal(state.eventSequence, previousSequence + 1);
    assert.ok(!emitted.has(state.events.at(-1).id));
    emitted.add(state.events.at(-1).id);
  }
  assert.equal(state.events.length, 16);
  assert.equal(state.eventSequence, 31);
  assert.equal(emitted.size, 31);
});
