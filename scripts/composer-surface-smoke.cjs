// Isolated Electron/CSS regression: no runtime server or user data is touched.
// Run after `npm run web:build`:
//   npx electron scripts/composer-surface-smoke.cjs
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { mkdtempSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "out/composer-surface-smoke");
const profile = mkdtempSync(path.join(os.tmpdir(), "Synax Surface Smoke "));
app.setPath("userData", profile);
const baseline = process.env.SYNAX_SURFACE_BASELINE === "1";
const label = baseline ? "before" : "after";
const contentClass = baseline ? "work-conversation" : "work-content-layout";
let win;
let exitCode = 0;
(async () => {
  await app.whenReady();
  await fs.mkdir(output, { recursive: true });
  const assets = path.join(root, "web/dist/assets");
  const css = (await fs.readdir(assets)).filter((file) =>
    file.endsWith(".css"),
  );
  assert(css.length, "Build the web app before running this check.");
  // Baseline mode restores the checked-in pre-fix rules over the same build.
  const baselineCss = baseline
    ? [
        "web/src/index.css",
        "web/src/react/features/agent-workspace/agentControls.css",
        "web/src/react/features/agent-workspace/workPage.css",
      ]
        .map((file) =>
          execFileSync("git", ["show", `HEAD:${file}`], {
            cwd: root,
            encoding: "utf8",
          }).replace(/^@import.*$/gm, ""),
        )
        .join("\n")
    : "";
  const html = `<!doctype html><html class="electron electron-macos"><head>
    ${css.map((file) => `<link rel="stylesheet" href="${pathToFileURL(path.join(assets, file)).href}">`).join("")}
    <style>${baselineCss}</style>
    <style>
      ${baseline ? ".agent-command-rail-inner{padding:0}" : ""}
      html,body{margin:0;width:100%;height:100%;overflow:hidden}
      .fixture-page{position:relative;height:100vh;display:flex;background:var(--background)}
      .fixture-sidebar{flex:0 0 160px;padding:24px 16px;color:var(--muted)}
      .fixture-message{max-width:48rem;margin:0 auto;padding:24px;font-size:14px}
      .fixture-message h2{font-size:20px;margin-bottom:16px}
      .fixture-message p{margin-bottom:18px;line-height:1.6}
      .fixture-spacer{height:800px}
      .fixture-input{display:block;resize:none;width:100%;height:60px;background:transparent;border:0;outline:0;padding:0;color:var(--foreground)}
      .fixture-toolbar{display:flex;align-items:center;gap:20px;font-size:12px;color:var(--muted);min-height:32px}
      .fixture-model{margin-left:auto}
      .fixture-header{position:absolute;top:12px;right:24px;z-index:40;padding:8px 16px;border-radius:30px;background:var(--surface);box-shadow:var(--surface-shadow)}
      .fixture-portal{position:fixed;top:100px;right:24px;z-index:40;display:flex;gap:12px;align-items:center}
    </style></head><body><div id="app" class="app-viewport">
    <div class="workbench-shell fixture-page agent-page-shell work-page">
      <header class="fixture-header"><div id="project-trigger" class="wh-project-trigger" role="button" tabindex="0">● f2e-supermarket-erp</div></header>
      <aside class="fixture-sidebar">Synax<br><br>对话列表</aside>
      <div class="${contentClass} flex min-w-0 flex-1 flex-col overflow-hidden">
        <div class="session-chat flex min-h-0 flex-1 flex-col">
          <div class="session-transcript-viewport relative min-h-0 flex-1">
            <div tabindex="0" aria-label="对话记录" class="session-chat-scroll h-full overflow-y-auto">
              <div class="session-transcript-body"><div class="fixture-message">
                <h2>直接显示在背景上的对话</h2><p>选择文字、聚焦输入框或用键盘滚动时，不应出现包裹整个对话区的矩形边框。</p>
                <button id="message-action">消息操作</button><div class="fixture-spacer"></div>
                <p id="last-message">最后一条消息：输入框四角不应出现被裁切的阴影。</p>
              </div></div>
            </div>
          </div>
        </div>
      </div>
      <div class="agent-command-rail" data-focus="false" style="left:160px;right:0">
        <div class="agent-command-rail-inner">
          <div class="agent-session-composer agent-session-composer--focus-rail w-full shrink-0">
            <div class="mx-auto w-full min-w-0 max-w-3xl"><div class="agent-session-controls w-full">
              <div class="session-composer-island" data-collapsed="false">
                <div class="session-composer-island-frame">
                  <div class="session-composer-island-content">
                    <div class="agent-session-composer-shell agent-dock-shell w-full flex flex-col items-center" data-multiline="true" data-has-media="false">
                      <div class="agent-dock-shell-content"><div class="agent-dock-composer" data-session-controls data-multiline="true" data-expanded="true">
                        <textarea class="fixture-input" placeholder="告诉 Synax 你想做什么… Shift+Enter 换行 · / 打开命令"></textarea>
                        <div class="fixture-toolbar"><button>＋</button><button>对话⌄</button><button>无限制⌄</button><span class="fixture-model">zhipu · glm-5.3-flash　 max</span><button>↑</button></div>
                      </div></div>
                    </div>
                  </div>
                  <div class="session-composer-island-pill"><button class="session-composer-island-expand">运行中⌃</button><button class="session-composer-island-stop">■</button></div>
                </div>
              </div>
            </div></div>
          </div>
        </div>
      </div>
    </div></div>
      <div class="fixture-portal">
        <button id="portal-button" class="button button--secondary" data-focus-visible="true">菜单操作</button>
        <label class="checkbox" data-focus-visible="true"><span id="checkbox-control" class="checkbox__control"></span></label>
        <input id="portal-input" class="input" data-focused="true" aria-label="搜索" value="搜索" style="width:100px">
      </div>
    </body></html>`;
  const fixturePath = path.join(output, "fixture.html");
  await fs.writeFile(fixturePath, html);
  win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 840,
    useContentSize: true,
    webPreferences: { backgroundThrottling: false },
  });
  await win.loadFile(fixturePath);
  // Exercise :focus-visible while the disposable test window stays hidden.
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand(
    "Emulation.setFocusEmulationEnabled",
    { enabled: true },
  );
  const metrics = [];
  for (const desktop of baseline ? [true] : [true, false]) {
    await win.webContents.executeJavaScript(`
      document.documentElement.classList.toggle('electron', ${desktop});
      document.documentElement.classList.toggle('electron-macos', ${desktop});
    `);
    for (const width of [1200, 760]) {
      win.setContentSize(width, 840);
      for (const theme of ["light", "dark"]) {
        await win.webContents.executeJavaScript(`new Promise(resolve => {
        document.documentElement.classList.toggle('dark', ${theme === "dark"});
        const island=document.querySelector('.session-composer-island');
        island.dataset.collapsed='false';
        const frame=island.querySelector('.session-composer-island-frame');
        island.style.setProperty('--composer-island-width', island.clientWidth+'px');
        frame.dataset.measured='true';
        island.style.setProperty('--composer-island-height', island.querySelector('.session-composer-island-content').scrollHeight+'px');
        setTimeout(resolve, 400);
      })`);
        for (const focus of [
          "input",
          "transcript",
          "message",
          "project",
          "portal",
          "selection",
          "collapsed",
        ]) {
          const data = await win.webContents
            .executeJavaScript(`new Promise(resolve => {
          const scroll=document.querySelector('.session-chat-scroll'), island=document.querySelector('.session-composer-island');
          const frame=island.querySelector('.session-composer-island-frame'), shell=island.querySelector('.agent-session-composer-shell');
          if ('${focus}' === 'input') document.querySelector('textarea').focus();
          if ('${focus}' === 'transcript') scroll.focus();
          if ('${focus}' === 'message') document.querySelector('#message-action').focus();
          if ('${focus}' === 'project') document.querySelector('#project-trigger').focus();
          if ('${focus}' === 'portal') document.querySelector('#portal-button').focus();
          if ('${focus}' === 'selection') {
            const range=document.createRange();range.selectNodeContents(document.querySelector('.fixture-message p'));
            getSelection().removeAllRanges();getSelection().addRange(range);
          }
          if ('${focus}' === 'collapsed') { document.activeElement.blur(); island.dataset.collapsed='true'; }
          setTimeout(() => {
            const clip=document.querySelector('.agent-command-rail-inner').getBoundingClientRect(), box=frame.getBoundingClientRect();
            const panel=getComputedStyle(document.querySelector('.${contentClass}'));
            const sc=getComputedStyle(shell), fc=getComputedStyle(frame);
            resolve({desktop:${desktop},theme:'${theme}',width:${width},focus:'${focus}',shellShadow:sc.boxShadow,frameShadow:fc.boxShadow,filter:sc.backdropFilter,
              panelBackground:panel.backgroundColor,panelShadow:panel.boxShadow,panelRadius:panel.borderRadius,
              outline:getComputedStyle(scroll).outlineStyle,
              gutter:{left:box.left-clip.left,right:clip.right-box.right,top:box.top-clip.top,bottom:clip.bottom-box.bottom},
              scrollable:scroll.scrollHeight>scroll.clientHeight,collapsed:box.width<240,
              heightMismatch:Math.abs(box.height-shell.getBoundingClientRect().height),
              focusHintPresent:!!document.querySelector('.session-transcript-focus-hint'),
              focusedOutline:getComputedStyle(document.activeElement).outlineStyle,
              portalOutlines:['portal-button','checkbox-control','portal-input'].map(id=>getComputedStyle(document.getElementById(id)).outlineStyle),
              portalRings:['portal-button','checkbox-control','portal-input'].map(id=>getComputedStyle(document.getElementById(id)).getPropertyValue('--tw-ring-shadow').trim()),
              focusedId:document.activeElement.id,
              hasSelection:getSelection().toString().length>0
            });
          },400);
        })`);
          metrics.push(data);
          if (focus !== "message" && focus !== "selection") {
            await fs.writeFile(
              path.join(
                output,
                `${label}${desktop ? "" : "-web"}-${theme}-${width}-${focus}.png`,
              ),
              (await win.webContents.capturePage()).toPNG(),
            );
          }
        }
      }
    }
  }
  await fs.writeFile(
    path.join(output, `${label}.json`),
    JSON.stringify(metrics, null, 2),
  );
  if (!baseline) {
    for (const m of metrics) {
      assert.equal(
        m.shellShadow,
        "none",
        "Inner composer must never regain a shadow (including focus and dark mode).",
      );
      assert.equal(
        m.filter,
        "none",
        "Solid composer must not inherit dock backdrop filtering.",
      );
      assert.equal(
        m.panelBackground,
        "rgba(0, 0, 0, 0)",
        "Conversation layout must not paint a card.",
      );
      assert.equal(m.panelShadow, "none");
      assert.equal(m.panelRadius, "0px");
      assert.equal(
        m.outline,
        "none",
        "Scroll focus must not outline the entire conversation.",
      );
      assert(m.scrollable, "Removing the card must preserve scrolling.");
      assert.equal(
        m.focusedOutline,
        "none",
        "Focused controls must not draw an outline.",
      );
      assert(
        m.portalOutlines.every((value) => value === "none"),
        "Portaled controls must not draw focus outlines.",
      );
      assert(
        m.portalRings.every((value) => value === "0 0 #0000"),
        "HeroUI focus rings must also be suppressed.",
      );
      if (m.focus === "project") assert.equal(m.focusedId, "project-trigger");
      if (m.focus === "portal") assert.equal(m.focusedId, "portal-button");
      if (m.focus === "selection")
        assert(m.hasSelection, "Text selection must remain available.");
      if (m.focus === "collapsed") {
        assert(m.collapsed, "Collapsed pill remains compact.");
        assert.equal(m.frameShadow, "none");
      } else {
        for (const [edge, gutter] of Object.entries(m.gutter))
          assert(gutter >= 11, `Shadow is clipped at ${edge}: ${gutter}px`);
        assert.notEqual(m.frameShadow, "none");
        assert(
          m.heightMismatch < 1,
          "Shadow frame must match the visible input height.",
        );
      }
      assert.equal(
        m.focusHintPresent,
        false,
        "No visible keyboard scrolling hint may be rendered.",
      );
    }
    console.log(
      `PASS ${metrics.length} composer/conversation CSS states; screenshots in ${output}`,
    );
  } else console.log(`Captured baseline in ${output}`);
})()
  .catch((error) => {
    console.error(error);
    exitCode = 1;
  })
  .finally(async () => {
    win?.destroy();
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
    app.exit(exitCode);
  });
