/**
 * High-confidence routing for conversation-only visual previews.
 *
 * This deliberately favors precision over recall: a normal request to build or
 * fix a UI must remain a coding task, while an explicit request to see a demo,
 * mockup or interactive preview should mount the visualize skill automatically.
 */
const VISUAL_CUES = [
  /(?:interactive|clickable|working)\s+(?:html|demo|prototype|mockup|preview)/i,
  /(?:html|ui|ux|页面|界面|组件|导航栏|卡片).*(?:demo|prototype|mockup|preview|visuali[sz]e|可视化|原型|预览|演示)/i,
  /(?:demo|prototype|mockup|preview|可视化|原型|预览|演示).*(?:html|ui|ux|页面|界面|组件|导航栏|卡片)/i,
  /(?:show|see|look|view|explore|展示|看看|看下|看一下|查看|预览|演示).*(?:how|what|效果|样式|样子|长什么样|交互|页面|界面|原型|demo|mockup|ui|ux)/i,
  /(?:make|create|做|做个|生成|画).*(?:demo|prototype|mockup|preview|原型|交互预览|可视化)/i,
  /(?:render|直接展示|直接渲染|对话中展示|对话内展示|inline).*(?:html|demo|prototype|mockup|preview|html|原型|页面)/i,
] as const;

const IMPLEMENTATION_CUES = [
  /(?:implement|build|develop|code|fix|repair|refactor|modify|落地|实现|开发|编码|修复|重构|修改|删除|新增|接入).*(?:component|feature|page|api|组件|功能|页面|接口|代码|逻辑)/i,
  /(?:write|edit|change|update).*(?:file|source|code|文件|源码|代码)/i,
];

export function isVisualizationIntent(input: string): boolean {
  const text = input.replace(/\s+/g, " ").trim();
  if (!text || text.length > 12_000) return false;
  if (!VISUAL_CUES.some((pattern) => pattern.test(text))) return false;
  // Explicit preview language wins when it is part of the same request.
  if (/(?:demo|prototype|mockup|preview|原型|预览|演示|可视化)/i.test(text)) {
    return true;
  }
  return !IMPLEMENTATION_CUES.some((pattern) => pattern.test(text));
}
