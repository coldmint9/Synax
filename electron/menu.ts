import { Menu, BrowserWindow, app, shell } from "electron";
import { showAboutWindow } from "./about-window.js";
import {
  menuCopy,
  resolveMenuLocale,
  type MenuCopy,
  type MenuLocale,
} from "./menu-copy.js";
import { onlineUpdatesEnabled } from "./updater/update-policy.js";

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
  dark: boolean;
  locale: MenuLocale;
}

let context: DesktopMenuState = {
  projectId: null,
  hasSession: false,
  hasViewer: false,
  inWork: false,
  dark: false,
  locale: "zh",
};
let checkUiUpdates: (() => void) | null = null;

export function updateMenuState(state: DesktopMenuState): void {
  context = { ...state, locale: resolveMenuLocale(state.locale) };
  buildAppMenu();
}

/**
 * Applies the OS language before the renderer reports its saved preference, so
 * the menu bar is never briefly in the wrong language at launch.
 */
export function setMenuLocale(raw: unknown): void {
  const locale = resolveMenuLocale(raw);
  if (locale === context.locale) return;
  context = { ...context, locale };
  buildAppMenu();
}

export function setUiUpdateAction(action: (() => void) | null): void {
  checkUiUpdates = action;
  buildAppMenu();
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  const win =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  win?.webContents.send(channel, ...args);
}

/** A renderer command whose menu id doubles as the action the renderer handles. */
function command(
  id: string,
  label: string,
  accelerator: string,
  enabled = true,
): Electron.MenuItemConstructorOptions {
  return {
    id,
    label,
    accelerator,
    enabled,
    click: () => sendToRenderer("menu:action", id),
  };
}

/** Fresh zoom items per build; Electron owns the option objects it receives. */
const zoomItems = (c: MenuCopy): Electron.MenuItemConstructorOptions[] => [
  { role: "zoomIn", label: c.zoomIn, accelerator: "CmdOrCtrl+=" },
  { role: "zoomOut", label: c.zoomOut, accelerator: "CmdOrCtrl+-" },
  { role: "resetZoom", label: c.actualSize, accelerator: "CmdOrCtrl+0" },
];

export function buildAppMenu(projects?: Project[]): void {
  if (projects) currentProjects = projects;
  const isMac = process.platform === "darwin";
  const c = menuCopy(context.locale);
  const preferences: Electron.MenuItemConstructorOptions = {
    label: c.settings,
    accelerator: "CmdOrCtrl+,",
    click: () => sendToRenderer("menu:navigate", "/settings"),
  };
  const projectSubmenu: Electron.MenuItemConstructorOptions[] =
    currentProjects.length
      ? currentProjects.map((p) => ({
          label: p.name,
          type: "checkbox",
          checked: p.id === context.projectId,
          click: () =>
            sendToRenderer(
              "menu:navigate",
              `/projects/${encodeURIComponent(p.id)}/sessions`,
            ),
        }))
      : [{ label: c.noProject, enabled: false }];

  const template: Electron.MenuItemConstructorOptions[] = [];
  if (isMac)
    template.push({
      label: app.name,
      submenu: [
        { label: c.about, click: () => showAboutWindow() },
        { type: "separator" },
        preferences,
        { type: "separator" },
        { role: "services", label: c.services },
        { type: "separator" },
        { role: "hide", label: c.hide },
        { role: "hideOthers", label: c.hideOthers },
        { role: "unhide", label: c.unhide },
        { type: "separator" },
        { role: "quit", label: c.quit },
      ],
    });
  template.push(
    {
      label: c.file,
      submenu: [
        command(
          "session:new",
          c.newTask,
          "CmdOrCtrl+N",
          Boolean(context.projectId),
        ),
        command(
          "terminal:new",
          c.newTerminal,
          "CmdOrCtrl+Shift+T",
          Boolean(context.projectId),
        ),
        { type: "separator" },
        command("project:import", c.importProject, "CmdOrCtrl+O"),
        { label: c.switchProject, submenu: projectSubmenu },
        // Close lives next to the file actions on macOS and in the window menu
        // elsewhere, so every platform exposes it exactly once.
        ...(isMac
          ? [
              { type: "separator" as const },
              { role: "close" as const, label: c.closeWindow },
            ]
          : [
              { type: "separator" as const },
              preferences,
              { type: "separator" as const },
              { role: "quit" as const, label: c.quit },
            ]),
      ],
    },
    {
      label: c.edit,
      submenu: [
        { role: "undo", label: c.undo },
        { role: "redo", label: c.redo },
        { type: "separator" },
        { role: "cut", label: c.cut },
        { role: "copy", label: c.copy },
        { role: "paste", label: c.paste },
        { role: "selectAll", label: c.selectAll },
        { type: "separator" },
        command("search:sessions", c.findSessions, "CmdOrCtrl+F"),
      ],
    },
    {
      label: c.view,
      submenu: [
        command(
          "terminal:toggle",
          c.toggleTerminal,
          "CmdOrCtrl+J",
          Boolean(context.projectId),
        ),
        command(
          "toggle:sidebar",
          c.toggleSidebar,
          "CmdOrCtrl+B",
          context.inWork,
        ),
        command(
          "view:conversation",
          c.backToConversation,
          "CmdOrCtrl+Alt+Left",
          context.hasViewer,
        ),
        { type: "separator" },
        command(
          "workspace:refresh",
          c.refreshWorkspace,
          "CmdOrCtrl+R",
          context.inWork && context.hasSession,
        ),
        { type: "separator" },
        {
          label: c.darkMode,
          id: "theme:toggle",
          type: "checkbox",
          checked: context.dark,
          accelerator: "CmdOrCtrl+Shift+L",
          click: () => sendToRenderer("menu:action", "theme:toggle"),
        },
        { type: "separator" },
        ...zoomItems(c),
        // macOS injects its own full-screen command into the View menu, so an
        // explicit item here would render a second, duplicate entry.
        ...(isMac
          ? []
          : [
              { type: "separator" as const },
              { role: "togglefullscreen" as const, label: c.fullscreen },
            ]),
        { type: "separator" },
        {
          role: "reload",
          label: c.reloadInterface,
          accelerator: "CmdOrCtrl+Shift+R",
        },
        // Inspection tools stay available in development builds only.
        ...(app.isPackaged
          ? []
          : [{ role: "toggleDevTools" as const, label: c.devTools }]),
      ],
    },
    {
      label: c.window,
      submenu: [
        { role: "minimize", label: c.minimize },
        ...(isMac
          ? [
              { role: "zoom" as const, label: c.zoom },
              { type: "separator" as const },
              { role: "front" as const, label: c.bringAllToFront },
            ]
          : [
              { type: "separator" as const },
              { role: "close" as const, label: c.closeWindow },
            ]),
      ],
    },
    {
      label: c.help,
      submenu: [
        ...(!isMac ? [{ label: c.about, click: () => showAboutWindow() }] : []),
        ...(onlineUpdatesEnabled() && app.isPackaged && (isMac || process.platform === "win32")
          ? [
              {
                label: c.checkUpdates,
                id: "ui:check-updates",
                enabled: Boolean(checkUiUpdates),
                click: () => checkUiUpdates?.(),
              },
              { type: "separator" as const },
            ]
          : []),
        {
          label: c.documentation,
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
