import { Menu, BrowserWindow, app, shell } from "electron";

interface Project {
  id: string;
  name: string;
}

let currentProjects: Project[] = [];
export interface DesktopMenuState {
  projectId: string | null;
  hasSession: boolean;
  hasViewer: boolean;
  inWork: boolean;
  inWiki: boolean;
  dark: boolean;
}
let context: DesktopMenuState = { projectId: null, hasSession: false, hasViewer: false, inWork: false, inWiki: false, dark: false };
export function updateMenuState(state: DesktopMenuState): void {
  context = state;
  buildAppMenu();
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  const win =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  win?.webContents.send(channel, ...args);
}

export function buildAppMenu(projects?: Project[]): void {
  if (projects) currentProjects = projects;
  const isMac = process.platform === "darwin";
  const preferences: Electron.MenuItemConstructorOptions = {
    label: "偏好设置...",
    accelerator: "CmdOrCtrl+,",
    click: () => sendToRenderer("menu:navigate", "/settings"),
  };
  const projectSubmenu: Electron.MenuItemConstructorOptions[] =
    currentProjects.length
      ? currentProjects.map((p) => ({
          label: p.name,
          type: "checkbox",
          checked: p.id === context.projectId,
          click: () => sendToRenderer("menu:navigate", `/projects/${encodeURIComponent(p.id)}/sessions`),
        }))
      : [{ label: "无项目", enabled: false }];

  const template: Electron.MenuItemConstructorOptions[] = [];
  if (isMac)
    template.push({
      label: app.name,
      submenu: [
        { role: "about", label: "关于 Synax" },
        { type: "separator" },
        preferences,
        { type: "separator" },
        { role: "services", label: "服务" },
        { type: "separator" },
        { role: "hide", label: "隐藏 Synax" },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "显示全部" },
        { type: "separator" },
        { role: "quit", label: "退出 Synax" },
      ],
    });
  template.push(
    {
      label: "文件",
      submenu: [
        {
          label: "导入项目…",
          id: "project:import",
          accelerator: "CmdOrCtrl+O",
          click: () => sendToRenderer("menu:action", "project:import"),
        },
        {
          label: "新任务",
          id: "session:new",
          accelerator: "CmdOrCtrl+N",
          enabled: Boolean(context.projectId),
          click: () => sendToRenderer("menu:action", "session:new"),
        },
        { type: "separator" },
        { label: "切换项目", submenu: projectSubmenu },
        { label: "新增终端", id: "terminal:new", accelerator: "CmdOrCtrl+Shift+T", enabled: Boolean(context.projectId), click: () => sendToRenderer("menu:action", "terminal:new") },
        { type: "separator" },
        { role: "close", label: "关闭窗口" },
        ...(!isMac
          ? [preferences, { role: "quit" as const, label: "退出 Synax" }]
          : []),
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "显示 / 隐藏终端", id: "terminal:toggle", accelerator: "CmdOrCtrl+J", click: () => sendToRenderer("menu:action", "terminal:toggle") },
        {
          label: "Work",
          id: "view:sessions",
          type: "checkbox", checked: context.inWork, enabled: Boolean(context.projectId),
          accelerator: "CmdOrCtrl+1",
          click: () => sendToRenderer("menu:action", "view:sessions"),
        },
        {
          label: "Wiki",
          id: "view:wiki",
          type: "checkbox", checked: context.inWiki, enabled: Boolean(context.projectId),
          accelerator: "CmdOrCtrl+2",
          click: () => sendToRenderer("menu:action", "view:wiki"),
        },
        { type: "separator" },
        {
          label: "切换会话侧栏",
          id: "toggle:sidebar",
          enabled: context.inWork,
          accelerator: "CmdOrCtrl+B",
          click: () => sendToRenderer("menu:action", "toggle:sidebar"),
        },
        { type: "separator" },
        {
          label: "返回对话", id: "view:conversation", accelerator: "CmdOrCtrl+Alt+Left",
          enabled: context.hasViewer,
          click: () => sendToRenderer("menu:action", "view:conversation"),
        },
        {
          label: "刷新工作区", id: "workspace:refresh", accelerator: "CmdOrCtrl+R",
          enabled: context.inWork && context.hasSession,
          click: () => sendToRenderer("menu:action", "workspace:refresh"),
        },
        {
          label: "深色模式", id: "theme:toggle", type: "checkbox", checked: context.dark,
          accelerator: "CmdOrCtrl+Shift+L",
          click: () => sendToRenderer("menu:action", "theme:toggle"),
        },
        { type: "separator" },
        { role: "toggleDevTools", label: "开发者工具" },
        { role: "reload", label: "重新加载界面", accelerator: "CmdOrCtrl+Shift+R" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        ...(isMac
          ? [
              { role: "zoom" as const, label: "缩放" },
              { type: "separator" as const },
              { role: "front" as const, label: "全部置前" },
            ]
          : [{ role: "close" as const, label: "关闭窗口" }]),
      ],
    },
    {
      label: "帮助",
      submenu: [
        ...(!isMac ? [{ role: "about" as const, label: "关于 Synax" }] : []),
        {
          label: "文档",
          click: () => shell.openExternal("https://github.com/coldmint9/Synax"),
        },
      ],
    },
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export function updateProjectsMenu(projects: Project[]): void {
  buildAppMenu(projects);
}
