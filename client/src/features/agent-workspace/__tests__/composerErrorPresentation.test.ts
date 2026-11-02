import { describe, expect, it } from "vitest";
import { composerErrorText } from "../composerErrorPresentation";

const knownErrors = [
  ["Modes are only available on primary native Synax sessions.", "仅原生 Synax 主会话支持切换模式。"],
  ["Stop the run and resolve any input form before switching mode.", "请先停止运行并处理待填写的表单，再切换模式。"],
  ["Close or stop the current orchestration before switching mode.", "请先结束或停止当前编排，再切换模式。"],
  ["Mode cannot be switched right now", "当前无法切换模式"],
] as const;

describe("composer error presentation", () => {
  it.each(knownErrors)("localizes only the known refusal: %s", (english, chinese) => {
    expect(composerErrorText(english, "zh")).toBe(chinese);
    expect(composerErrorText(english, "en")).toBe(english);
  });

  it.each([
    "Unknown upstream failure: request=abc123\nretry-after=30",
    "Stop the run and resolve any input form before switching mode. Details: newer server reason",
    "新的服务端错误：保留详情",
    "constructor",
    "__proto__",
    "",
  ])("preserves unfamiliar errors exactly in both locales: %s", (message) => {
    expect(composerErrorText(message, "zh")).toBe(message);
    expect(composerErrorText(message, "en")).toBe(message);
  });
});
