import { Menu, BrowserWindow, app, shell } from 'electron';
let currentProjects = [];
function getMainWindow() {
    const windows = BrowserWindow.getAllWindows();
    return windows[0] ?? null;
}
function sendToRenderer(channel, ...args) {
    const win = getMainWindow();
    if (win)
        win.webContents.send(channel, ...args);
}
export function buildAppMenu(projects) {
    if (projects)
        currentProjects = projects;
    const projectSubmenu = currentProjects.length > 0
        ? currentProjects.map((p) => ({
            label: p.name,
            click: () => sendToRenderer('menu:navigate', `/projects/${p.id}`),
        }))
        : [{ label: '无项目', enabled: false }];
    const template = [
        {
            label: app.name,
            submenu: [
                { role: 'about', label: '关于 Synapse' },
                { type: 'separator' },
                {
                    label: '偏好设置...',
                    accelerator: 'CmdOrCtrl+,',
                    click: () => sendToRenderer('menu:navigate', '/settings'),
                },
                { type: 'separator' },
                { role: 'services', label: '服务' },
                { type: 'separator' },
                { role: 'hide', label: '隐藏 Synapse' },
                { role: 'hideOthers', label: '隐藏其他' },
                { role: 'unhide', label: '显示全部' },
                { type: 'separator' },
                { role: 'quit', label: '退出 Synapse' },
            ],
        },
        {
            label: '文件',
            submenu: [
                {
                    label: '新建项目',
                    accelerator: 'CmdOrCtrl+N',
                    click: () => sendToRenderer('menu:navigate', '/projects/new'),
                },
                { type: 'separator' },
                { label: '切换项目', submenu: projectSubmenu },
                { type: 'separator' },
                { role: 'close', label: '关闭窗口' },
            ],
        },
        {
            label: '编辑',
            submenu: [
                { role: 'undo', label: '撤销' },
                { role: 'redo', label: '重做' },
                { type: 'separator' },
                { role: 'cut', label: '剪切' },
                { role: 'copy', label: '复制' },
                { role: 'paste', label: '粘贴' },
                { role: 'selectAll', label: '全选' },
            ],
        },
        {
            label: '视图',
            submenu: [
                {
                    label: 'Coordinates',
                    accelerator: 'CmdOrCtrl+1',
                    click: () => sendToRenderer('menu:action', 'view:coordinates'),
                },
                {
                    label: 'Wiki',
                    accelerator: 'CmdOrCtrl+2',
                    click: () => sendToRenderer('menu:action', 'view:wiki'),
                },
                {
                    label: 'Sessions',
                    accelerator: 'CmdOrCtrl+3',
                    click: () => sendToRenderer('menu:action', 'view:sessions'),
                },
                { type: 'separator' },
                {
                    label: '切换侧边栏',
                    accelerator: 'CmdOrCtrl+B',
                    click: () => sendToRenderer('menu:action', 'toggle:sidebar'),
                },
                { type: 'separator' },
                { role: 'toggleDevTools', label: '开发者工具' },
                { role: 'reload', label: '重新加载' },
                { type: 'separator' },
                { role: 'togglefullscreen', label: '全屏' },
            ],
        },
        {
            label: '窗口',
            submenu: [
                { role: 'minimize', label: '最小化' },
                { role: 'zoom', label: '缩放' },
                { type: 'separator' },
                { role: 'front', label: '全部置前' },
            ],
        },
        {
            label: '帮助',
            submenu: [
                {
                    label: '文档',
                    click: () => shell.openExternal('https://github.com'),
                },
            ],
        },
    ];
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}
export function updateProjectsMenu(projects) {
    buildAppMenu(projects);
}
