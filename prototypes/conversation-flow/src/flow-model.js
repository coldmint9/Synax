/**
 * State model for the inline Git resolution conversation prototype.
 *
 * This module is deliberately free of React, timers, and transport calls. The
 * visual prototype can therefore replay the same conversation deterministically
 * in a browser, while the production implementation can replace these actions
 * with native Git operations later.
 */

export const stages = Object.freeze([
  { id: "scanning", label: "扫描变更" },
  { id: "conflict", label: "发现冲突" },
  { id: "testing", label: "运行测试" },
  { id: "ready", label: "可以合并" },
  { id: "merging", label: "合并中" },
  { id: "merged", label: "已合并" },
  { id: "failed", label: "测试失败" },
  { id: "stale", label: "需要重新扫描" },
]);

const choices = Object.freeze(["local", "incoming", "combined"]);

export const files = Object.freeze([
  {
    id: "auth",
    name: "auth.ts",
    path: "src/auth/auth.ts",
    title: "会话刷新策略",
    summary:
      "feature 分支更新了过期 token 的刷新边界，main 分支轮换密钥时保留了旧会话兼容。",
    recommendation: "combined",
    local: `export async function refreshSession(token: string) {
  if (isExpired(token)) {
    return (await refreshWithRotation(token)).token
  }
  return token
}`,
    incoming: `export async function refreshSession(token: string) {
  const rotated = await rotateSigningKeyIfNeeded()
  const session = await verifyAndRefresh(token, rotated)
  await rememberActiveKey(session.keyId)
  return session.token
}`,
    combined: `export async function refreshSession(token: string) {
  const rotated = await rotateSigningKeyIfNeeded()
  const session = isExpired(token)
    ? await refreshWithRotation(token, rotated)
    : await verifyAndRefresh(token, rotated)
  await rememberActiveKey(session.keyId)
  return session.token
}`,
    explanations: {
      local: "保留 feature 的过期刷新判断，适合只修复刷新边界。",
      incoming: "采用 main 的密钥轮换流程，适合跟随生产安全策略。",
      combined: "先轮换密钥，再保留 feature 的过期刷新兼容。",
    },
  },
  {
    id: "middleware",
    name: "middleware.ts",
    path: "src/middleware.ts",
    title: "登录重定向与缓存",
    summary:
      "两个分支都修改了请求入口：feature 增加公共资源缓存，main 补上了未登录时的 redirect。",
    recommendation: "combined",
    local: `export async function middleware(request: Request) {
  if (isPublicAsset(request) && isCached(request)) {
    return next(request)
  }
  const session = await getSession(request)
  return nextWithSession(request, session)
}`,
    incoming: `export async function middleware(request: Request) {
  const session = await getSession(request)
  if (!session) {
    return redirectToLogin(request)
  }
  return next(request)
}`,
    combined: `export async function middleware(request: Request) {
  const cachedAsset = isPublicAsset(request) && isCached(request)
  if (cachedAsset) return next(request)
  const session = await getSession(request)
  if (!session) return redirectToLogin(request)
  return next(request)
}`,
    explanations: {
      local: "保留公共资源缓存命中，减少静态请求的重复鉴权。",
      incoming: "保留 main 的登录保护，未登录请求跳转登录页。",
      combined: "仅公共资源缓存快速放行，受保护的请求继续验证登录。",
    },
  },
]);

const fileById = new Map(files.map((file) => [file.id, file]));
const initialChoices = Object.fromEntries(
  files.map((file) => [file.id, file.recommendation]),
);

export const initialState = Object.freeze({
  stage: "conflict",
  choices: Object.freeze(initialChoices),
  confirmed: Object.freeze([]),
  testProgress: 0,
  simulateFailure: false,
  revision: 1,
  eventSequence: 1,
  events: Object.freeze([
    {
      id: "conflict-detected:1",
      text: "检测到 2 个文件存在合并冲突，请选择解决方案。",
      kind: "warning",
    },
  ]),
});

const cloneState = (state) => ({
  ...state,
  choices: { ...state.choices },
  confirmed: [...state.confirmed],
  events: [...state.events],
});

const withEvent = (state, event) => {
  if (!event) return state;
  const eventSequence = state.eventSequence + 1;
  const events = [
    ...state.events,
    { ...event, id: `${event.id}:${eventSequence}` },
  ];
  // Keep the transcript compact; the UI only needs the latest handoff context.
  // Idempotence belongs to each action's guard. A later genuine decision needs
  // a new instance even if it returns to an earlier choice or repeats a scan.
  return { ...state, eventSequence, events: events.slice(-16) };
};

const event = (id, text, kind = "info") => ({ id, text, kind });

const validChoice = (choice) => choices.includes(choice);
const allConfirmed = (state) =>
  files.every((file) => state.confirmed.includes(file.id));

const resetState = () => ({
  ...initialState,
  choices: { ...initialState.choices },
  confirmed: [],
  events: [...initialState.events],
});

export function flowReducer(state = initialState, action = {}) {
  if (!action || typeof action.type !== "string") return state;

  switch (action.type) {
    case "CHOOSE":
    case "CHOOSE_SOLUTION": {
      if (state.stage !== "conflict") return state;
      const fileId = action.fileId;
      const choice = action.choice;
      if (!fileById.has(fileId) || !validChoice(choice)) return state;
      if (state.choices[fileId] === choice) return state;
      const next = cloneState(state);
      next.choices[fileId] = choice;
      // Changing a choice invalidates only that file's earlier confirmation.
      next.confirmed = next.confirmed.filter((id) => id !== fileId);
      return withEvent(
        next,
        event(
          `choice:${fileId}:${choice}`,
          `${fileById.get(fileId).name} 已选择${choice === "local" ? "本地方案" : choice === "incoming" ? "来源方案" : "组合方案"}，等待确认。`,
        ),
      );
    }

    case "CONFIRM_FILE":
    case "CONFIRM_SOLUTION": {
      if (state.stage !== "conflict") return state;
      const fileId = action.fileId;
      if (!fileById.has(fileId) || !validChoice(state.choices[fileId]))
        return state;
      if (state.confirmed.includes(fileId)) return state;
      const next = cloneState(state);
      next.confirmed.push(fileId);
      return withEvent(
        next,
        event(
          `confirmed:${fileId}`,
          `${fileById.get(fileId).name} 的解决方案已确认。`,
          "success",
        ),
      );
    }

    case "RUN_TESTS": {
      if (state.stage !== "conflict" || !allConfirmed(state)) return state;
      const next = cloneState(state);
      next.stage = "testing";
      next.testProgress = 0;
      return withEvent(
        next,
        event("tests-started", "两个冲突文件已确认，开始运行 42 个测试。"),
      );
    }

    case "TICK_TESTS":
    case "TEST_TICK": {
      if (state.stage !== "testing") return state;
      const amount = Number.isFinite(action.amount) ? action.amount : 7;
      const progress = Math.max(
        0,
        Math.min(42, state.testProgress + Math.max(1, Math.floor(amount))),
      );
      const next = cloneState(state);
      next.testProgress = progress;
      if (progress < 42) return next;
      if (state.simulateFailure) {
        next.stage = "failed";
        return withEvent(
          next,
          event(
            "tests-failed",
            "测试在最后一个场景失败，修复后可以重新运行。",
            "error",
          ),
        );
      }
      next.stage = "ready";
      return withEvent(
        next,
        event(
          "tests-passed",
          "42 个测试全部通过，可以合并到 main。",
          "success",
        ),
      );
    }

    case "SET_SIMULATE_FAILURE":
    case "SIMULATE_FAILURE": {
      if (state.stage === "merged") return state;
      const value =
        typeof action.value === "boolean"
          ? action.value
          : !state.simulateFailure;
      if (value === state.simulateFailure) return state;
      return { ...state, simulateFailure: value };
    }

    case "RETRY_TESTS":
    case "RETRY": {
      if (state.stage !== "failed") return state;
      const next = cloneState(state);
      next.stage = "testing";
      next.testProgress = 0;
      return withEvent(
        next,
        event("tests-retry", "重新运行测试，沿用已确认的解决方案。"),
      );
    }

    case "MERGE": {
      if (state.stage !== "ready") return state;
      const next = cloneState(state);
      next.stage = "merging";
      return withEvent(
        next,
        event("merge-started", "方案已锁定，正在将结果合并到 main。"),
      );
    }

    case "MERGE_DONE":
    case "MERGE_COMPLETE": {
      if (state.stage !== "merging") return state;
      const next = cloneState(state);
      next.stage = "merged";
      return withEvent(
        next,
        event("merge-complete", "合并完成，工作区已更新。", "success"),
      );
    }

    case "MERGE_GUARD": {
      if (state.stage !== "ready" && state.stage !== "merging") return state;
      const next = cloneState(state);
      next.stage = "stale";
      next.revision += 1;
      next.testProgress = 0;
      next.confirmed = [];
      return withEvent(
        next,
        event(
          "main-updated",
          "main 在检查期间发生了更新，需要重新扫描冲突。",
          "warning",
        ),
      );
    }

    case "RESCAN": {
      if (state.stage !== "stale") return state;
      const next = cloneState(state);
      next.stage = "scanning";
      return withEvent(
        next,
        event("rescan-started", "正在重新扫描最新的 main。"),
      );
    }

    case "SCAN_DONE":
    case "SCAN_COMPLETE": {
      if (state.stage !== "scanning") return state;
      const next = cloneState(state);
      next.stage = "conflict";
      next.choices = { ...initialChoices };
      next.confirmed = [];
      next.testProgress = 0;
      return withEvent(
        next,
        event(
          "conflict-rescanned",
          "重新扫描完成，发现 2 个冲突文件。",
          "warning",
        ),
      );
    }

    case "RESET":
      return resetState();

    default:
      return state;
  }
}
