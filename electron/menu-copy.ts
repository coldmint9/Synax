/**
 * Native menu copy for the two interface languages the renderer supports.
 * The menu lives in the main process, so it cannot read the renderer's i18n
 * catalogue and keeps its own small table instead.
 */
export type MenuLocale = "zh" | "en";

export interface MenuCopy {
  about: string;
  settings: string;
  services: string;
  hide: string;
  hideOthers: string;
  unhide: string;
  quit: string;
  file: string;
  newTask: string;
  newTerminal: string;
  importProject: string;
  switchProject: string;
  noProject: string;
  closeWindow: string;
  edit: string;
  undo: string;
  redo: string;
  cut: string;
  copy: string;
  paste: string;
  selectAll: string;
  findSessions: string;
  view: string;
  toggleTerminal: string;
  toggleSidebar: string;
  backToConversation: string;
  refreshWorkspace: string;
  darkMode: string;
  zoomIn: string;
  zoomOut: string;
  actualSize: string;
  fullscreen: string;
  reloadInterface: string;
  devTools: string;
  window: string;
  minimize: string;
  zoom: string;
  bringAllToFront: string;
  help: string;
  checkUpdates: string;
  documentation: string;
}

const zh: MenuCopy = {
  about: "关于 Synax",
  settings: "设置…",
  services: "服务",
  hide: "隐藏 Synax",
  hideOthers: "隐藏其他",
  unhide: "显示全部",
  quit: "退出 Synax",
  file: "文件",
  newTask: "新建任务",
  newTerminal: "新增终端",
  importProject: "导入项目…",
  switchProject: "切换项目",
  noProject: "无项目",
  closeWindow: "关闭窗口",
  edit: "编辑",
  undo: "撤销",
  redo: "重做",
  cut: "剪切",
  copy: "复制",
  paste: "粘贴",
  selectAll: "全选",
  findSessions: "查找会话…",
  view: "视图",
  toggleTerminal: "显示 / 隐藏终端",
  toggleSidebar: "切换会话侧栏",
  backToConversation: "返回对话",
  refreshWorkspace: "刷新工作区",
  darkMode: "深色模式",
  zoomIn: "放大",
  zoomOut: "缩小",
  actualSize: "实际大小",
  fullscreen: "全屏",
  reloadInterface: "重新加载界面",
  devTools: "开发者工具",
  window: "窗口",
  minimize: "最小化",
  zoom: "缩放",
  bringAllToFront: "全部置前",
  help: "帮助",
  checkUpdates: "软件更新…",
  documentation: "文档",
};

const en: MenuCopy = {
  about: "About Synax",
  settings: "Settings…",
  services: "Services",
  hide: "Hide Synax",
  hideOthers: "Hide Others",
  unhide: "Show All",
  quit: "Quit Synax",
  file: "File",
  newTask: "New Task",
  newTerminal: "New Terminal",
  importProject: "Import Project…",
  switchProject: "Switch Project",
  noProject: "No Project",
  closeWindow: "Close Window",
  edit: "Edit",
  undo: "Undo",
  redo: "Redo",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  selectAll: "Select All",
  findSessions: "Find Sessions…",
  view: "View",
  toggleTerminal: "Toggle Terminal",
  toggleSidebar: "Toggle Session Sidebar",
  backToConversation: "Back to Conversation",
  refreshWorkspace: "Refresh Workspace",
  darkMode: "Dark Mode",
  zoomIn: "Zoom In",
  zoomOut: "Zoom Out",
  actualSize: "Actual Size",
  fullscreen: "Toggle Full Screen",
  reloadInterface: "Reload Interface",
  devTools: "Developer Tools",
  window: "Window",
  minimize: "Minimize",
  zoom: "Zoom",
  bringAllToFront: "Bring All to Front",
  help: "Help",
  checkUpdates: "Check for Updates…",
  documentation: "Documentation",
};

/** Normalises a renderer preference or an OS locale such as `en-US`. */
export function resolveMenuLocale(raw: unknown): MenuLocale {
  return typeof raw === "string" && raw.trim().toLowerCase().startsWith("en")
    ? "en"
    : "zh";
}

export function menuCopy(locale: MenuLocale): MenuCopy {
  return locale === "en" ? en : zh;
}
