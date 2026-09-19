import { Menu, BrowserWindow, app, shell } from "electron";

interface Project {
  id: string;
  name: string;
}

let currentProjects: Project[] = [];

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
          click: () => sendToRenderer("menu:navigate", `/projects/${p.id}`),
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
          label: "新建项目",
          accelerator: "CmdOrCtrl+N",
          click: () => sendToRenderer("menu:navigate", "/projects/new"),
        },
        { type: "separator" },
        { label: "切换项目", submenu: projectSubmenu },
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
        {
          label: "Work",
          accelerator: "CmdOrCtrl+1",
          click: () => sendToRenderer("menu:action", "view:sessions"),
        },
        {
          label: "Wiki",
          accelerator: "CmdOrCtrl+2",
          click: () => sendToRenderer("menu:action", "view:wiki"),
        },
        { type: "separator" },
        {
          label: "切换侧边栏",
          accelerator: "CmdOrCtrl+B",
          click: () => sendToRenderer("menu:action", "toggle:sidebar"),
        },
        { type: "separator" },
        { role: "toggleDevTools", label: "开发者工具" },
        { role: "reload", label: "重新加载" },
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
          click: () => shell.openExternal("https://github.com"),
        },
      ],
    },
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export function updateProjectsMenu(projects: Project[]): void {
  buildAppMenu(projects);
}
