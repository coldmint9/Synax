import { describe, expect, it } from "vitest";
import { isVisualizationIntent } from "../visualization-intent.js";

describe("visualization intent routing", () => {
  it.each([
    "做一个导航栏 demo 给我看看",
    "先给我一个可交互的 HTML 原型预览",
    "show me a clickable mockup of the settings page",
    "在对话中展示这个页面的效果，不要先写正式代码",
    "做个 UI mockup 看看交互",
  ])("routes explicit preview requests: %s", (request) => {
    expect(isVisualizationIntent(request)).toBe(true);
  });

  it.each([
    "实现一个导航栏组件并接入当前页面",
    "修复这个页面的布局问题",
    "把设置页落地到 web/src/react",
    "修改 API 接口并补测试",
    "解释一下这个组件怎么工作",
  ])("does not route implementation or explanation requests: %s", (request) => {
    expect(isVisualizationIntent(request)).toBe(false);
  });

  it("allows an explicit preview cue to override implementation wording", () => {
    expect(isVisualizationIntent("实现一个导航栏 demo 给我预览")).toBe(true);
  });
});
