/** Real packaged renderer + authenticated API, using disposable repositories/data. No model calls. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  _electron,
  type ElectronApplication,
  type Page,
} from "playwright-core";

const output = path.resolve("out/workbench-e2e");
await mkdir(output, { recursive: true });
const temp = await mkdtemp(path.join(os.tmpdir(), "Synax Workbench E2E "));
process.env.DATA_ROOT = path.join(temp, "data");
process.env.LOG_LEVEL = "error";
const executablePath =
  process.argv[2] ??
  path.resolve(
    `out/Synax-${process.platform}-${process.arch}/${process.platform === "darwin" ? "Synax.app/Contents/MacOS/Synax" : process.platform === "win32" ? "Synax.exe" : "Synax"}`,
  );
await mkdir(path.join(temp, "home"));
process.env.HOME = path.join(temp, "home");
process.env.ZDOTDIR = path.join(temp, "home");
const env = { ...process.env, DATA_ROOT: process.env.DATA_ROOT } as Record<
  string,
  string
>;
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_SKIP_SIDECAR;
delete env.NODE_OPTIONS;
let desktop: ElectronApplication | undefined;
let page: Page | undefined;
let logs = "";
const passed: string[] = [];
let stopServices: (() => Promise<void>) | undefined;
let closeDb: (() => void) | undefined;
const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const check = (name: string) => {
  passed.push(name);
  console.log(`PASS ${name}`);
};

try {
  const repository = path.join(temp, "项目 with spaces");
  await mkdir(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.email", "e2e@example.test");
  git(repository, "config", "user.name", "E2E");
  git(repository, "config", "commit.gpgsign", "false");
  await writeFile(
    path.join(repository, "main.ts"),
    'export const branch = "main";\n',
  );
  git(repository, "add", ".");
  git(repository, "commit", "-m", "initial");
  git(repository, "switch", "-c", "feature/ui");
  await writeFile(
    path.join(repository, "main.ts"),
    'export const branch = "feature";\n',
  );
  git(repository, "commit", "-am", "feature");
  git(repository, "switch", "main");
  desktop = await _electron.launch({
    executablePath,
    args: [`--user-data-dir=${path.join(temp, "profile")}`],
    env,
    timeout: 60_000,
  });
  desktop.process().stdout?.on("data", (data) => {
    logs += data;
  });
  desktop.process().stderr?.on("data", (data) => {
    logs += data;
  });
  page = await desktop.firstWindow({ timeout: 60_000 });
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await desktop.evaluate(({ BrowserWindow }, interactive) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!interactive) win.setFocusable(false);
    win.setContentSize(1440, 900);
    win.setTitle("Synax — E2E");
  }, process.env.SYNAX_E2E_NATIVE_CHECK === "1");
  await page.waitForSelector(".project-import-hint");
  assert.match(
    await page.locator(".wh-project-trigger").innerText(),
    /切换项目/,
  );
  assert.equal(
    await page.locator(".project-import-hint-arrow path").count(),
    1,
  );
  await page.screenshot({ path: path.join(output, "01-import-guide.png") });
  check("first visit: project switch label and anchored SVG import guide");

  await page.locator(".project-import-hint-action").click();
  await page.getByRole("dialog").waitFor();
  await page.locator(".project-import-hint").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.reload();
  await page.locator(".wh-project-trigger").waitFor();
  assert.equal(await page.locator(".project-import-hint").count(), 0, "cancelling import must not restore the guide");

  // Reset only this disposable profile's guide flag to test the other entry point.
  await page.evaluate(() => localStorage.removeItem("synax:project-import-hint-dismissed"));
  await page.reload();
  await page.locator(".project-import-hint").waitFor();
  await page.locator(".wh-project-trigger").click();
  await page.getByRole("menu").waitFor();
  await page.locator(".project-import-hint").waitFor({ state: "detached" });
  await page.keyboard.press("Escape");
  await page.reload();
  await page.locator(".wh-project-trigger").waitFor();
  assert.equal(await page.locator(".project-import-hint").count(), 0, "using the switcher must permanently dismiss the guide");
  check("import guide closes on either entry point and stays closed after cancellation and reload");


  const menu = async (id: string) => {
    await desktop!.evaluate(({ Menu }, id) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(id);
      if (!item?.enabled)
        throw new Error(`Disabled/missing native menu: ${id}`);
      item.click();
    }, id);
  };
  await menu("project:import");
  await page.getByRole("dialog").waitFor();
  await page.getByRole("textbox", { name: "工作区名称" }).fill("Workbench E2E");
  await page.getByRole("textbox", { name: "项目目录路径" }).fill(repository);
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByRole("button", { name: /创建工作区/ }).click();
  await page.waitForURL(/\/projects\/[^/]+\/sessions/);
  const projectId = page.url().match(/\/projects\/([^/]+)/)![1];
  assert.equal(await page.locator(".project-import-hint").count(), 0);
  check("native import command and real workspace import through UI");

  const runtime =
    await import("../api/services/agent-runtime/session-runtime.js");
  const { agentRuntimeStore } =
    await import("../api/services/agent-runtime/session-store.js");
  const { ensureSynaxAgentRegistered } =
    await import("../api/services/agent-runtime/synax/index.js");
  const database = await import("../api/db/index.js");
  closeDb = database.closeDb;
  ensureSynaxAgentRegistered();
  const session = runtime.agentSessionRuntime.create({
    projectId,
    profileId: "synax",
    prompt: "工作区端到端验证",
    workDir: repository,
    sessionMetadata: { mode: "chat", source: "session-page" },
  });
  agentRuntimeStore.updateSession(session.id, { status: "completed" });
  const db = database.getRawSqlite();
  const stamp = new Date().toISOString();
  for (const [index, role, content] of [
    [0, "user", "请检查工作区中的文件与后台服务。"],
    [
      1,
      "assistant",
      "这是用于验证工作区界面的本地测试对话。\n\n" +
        "文件、Git 变更与服务状态都可以在侧栏中查看。\n\n".repeat(25),
    ],
  ] as const) {
    db.prepare(
      "INSERT INTO agent_runtime_messages (id,session_id,project_id,sequence,role,content,created_at) VALUES (?,?,?,?,?,?,?)",
    ).run(
      `e2e-message-${index}`,
      session.id,
      projectId,
      index,
      role,
      content,
      stamp,
    );
  }
  for (let i = 0; i < 30; i++) {
    const name = i ? `output-${i}.ts` : "main.ts";
    if (i)
      await writeFile(
        path.join(repository, name),
        `export const output${i} = ${i};\n`,
      );
    for (const [tool, mutability] of [
      ["file.read", "read"],
      ["file.write", "write"],
    ] as const) {
      db.prepare(
        `INSERT INTO agent_runtime_tool_calls (id,session_id,tool_id,category,mutability,input_summary,input_ref_json,status,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        `e2e-${tool}-${i}`,
        session.id,
        tool,
        mutability,
        mutability,
        name,
        JSON.stringify({ path: name }),
        "completed",
        stamp,
        stamp,
      );
    }
  }
  for (let i = 0; i < 5; i++)
    db.prepare(
      `INSERT INTO agent_runtime_processes (id,host_id,session_id,command_label,state,started_at,ended_at,kind,exit_code) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      `e2e-closed-${i}`,
      "e2e",
      session.id,
      `node a-very-long-background-service-command-${i}.js --host=127.0.0.1 --explain-layout-wrap`,
      "closed",
      stamp,
      stamp,
      "background",
      i % 2,
    );
  const { runBackgroundShellCommand } =
    await import("../api/services/agent-runtime/tools/exec-async.js");
  const { stopSessionBackgroundProcess } =
    await import("../api/services/agent-runtime/session-background-processes.js");
  const command = `${JSON.stringify(process.execPath)} -e 'setInterval(()=>{},1000)'`;
  const service = await runBackgroundShellCommand(session.id, command, {
    cwd: repository,
  });
  stopServices = async () => {
    try {
      await stopSessionBackgroundProcess(session.id, service.processId);
    } catch {
      /* May already be deleted. */
    }
  };
  await desktop.evaluate(
    ({ BrowserWindow }, route) =>
      BrowserWindow.getAllWindows()[0].webContents.send("menu:navigate", route),
    `/projects/${projectId}/sessions?session=${session.id}`,
  );
  await page.reload();
  await page.locator(".workspace-dashboard--pinned .ws-project-card").waitFor();
  await page.getByRole("button", { name: "产出文件 30" }).waitFor();
  assert.equal(
    await page
      .locator(".session-list-titlebar-row")
      .getByText("任务", { exact: true })
      .count(),
    0,
  );
  assert.equal(await page.getByRole("button", { name: /Workflow/ }).count(), 0);
  check("no redundant Tasks heading or premature Workflow shortcut");

  const assertTranscriptClearsIsland = async (resetScroll = true) => {
    await page!
      .locator(".session-chat-scroll")
      .getByText("请检查工作区中的文件与后台服务。", { exact: true })
      .waitFor();
    if (resetScroll) {
      await page!
        .locator(".session-chat-scroll")
        .evaluate((element) => element.scrollTo({ top: 0, behavior: "instant" }));
    }
    const positions = await page!.evaluate(() => {
      const island = document
        .querySelector(".workbench-header")!
        .getBoundingClientRect();
      const scroll = document
        .querySelector(".session-chat-scroll")!
        .getBoundingClientRect();
      return { islandBottom: island.bottom, transcriptTop: scroll.top };
    });
    assert(
      positions.transcriptTop >= positions.islandBottom + 8 - 1,
      `conversation viewport must clear the island: ${JSON.stringify(positions)}`,
    );
    const firstMessage = await page!
      .locator(".session-chat-scroll")
      .getByText("请检查工作区中的文件与后台服务。", { exact: true })
      .boundingBox();
    assert(
      firstMessage && firstMessage.y >= positions.islandBottom + 8 - 1,
      "first message must not be behind the island",
    );
  };
  await assertTranscriptClearsIsland();
  await page
    .getByRole("button", {
      name: "跳转到第 1 轮：请检查工作区中的文件与后台服务。",
      exact: true,
    })
    .click();
  await assertTranscriptClearsIsland(false);
  check(
    "conversation viewport and first message remain below the island, including turn navigation",
  );

  for (const label of ["Git 变更", "输入源", "产出文件"]) {
    const toggle = page
      .locator(".ws-project-section-toggle")
      .filter({ hasText: label });
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  }
  const headerRects = () =>
    page!
      .locator(
        ".workspace-dashboard--pinned .workspace-projects-pane > .ws-card > .ws-card-head, .workspace-dashboard--pinned > .bui-processes > .ws-card-head, .work-runtime-details > .ws-card > .ws-card-head",
      )
      .evaluateAll((elements) =>
        elements.map((el) => ({
          y: el.getBoundingClientRect().y,
          bottom: el.getBoundingClientRect().bottom,
        })),
      );
  const before = await headerRects();
  assert.equal(before.length, 3);
  assert(before.every((item) => item.y >= 0 && item.bottom <= 900));
  await page
    .locator(".workspace-dashboard--pinned .ws-card-body")
    .evaluateAll((elements) =>
      elements.forEach((el) => {
        el.scrollTop = 10000;
      }),
    );
  assert.deepEqual(await headerRects(), before);
  await page.getByRole("button", { name: /运行详情/, exact: false }).click();
  assert((await headerRects()).every((item) => item.bottom <= 900));
  await page.getByRole("button", { name: /运行详情/, exact: false }).click();
  await page.locator(".ws-project-card > .ws-card-body").evaluate((el) => {
    el.scrollTop = 0;
  });
  check(
    "three pinned headers, independent scrolling, all nested sections fold",
  );

  await page
    .getByRole("button", { name: `终止 ${command}`, exact: true })
    .click();
  await page
    .getByRole("button", { name: `终止 ${command}`, exact: true })
    .waitFor({ state: "detached" });
  assert.throws(() => process.kill(service.pid, 0), /ESRCH/);
  await page
    .getByRole("button", { name: `删除记录 ${command}`, exact: true })
    .click();
  await page
    .getByRole("button", { name: `删除记录 ${command}`, exact: true })
    .waitFor({ state: "detached" });
  assert.equal(
    db
      .prepare("SELECT id FROM agent_runtime_processes WHERE id=?")
      .get(service.processId),
    undefined,
  );
  check("UI stops a real owned process and deletes only its history");

  await page
    .getByRole("button", { name: "切换 Git 分支: main", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "feature/ui", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /uncommitted/ })
    .waitFor();
  await page
    .locator(".bg-surface")
    .filter({ hasText: /Commit or stash uncommitted/ })
    .getByRole("button")
    .last()
    .click();
  assert.equal(git(repository, "branch", "--show-current"), "main");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "outputs");
  await page
    .getByRole("button", { name: "切换 Git 分支: main", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "feature/ui", exact: true }).click();
  await page
    .getByRole("button", { name: "切换 Git 分支: feature/ui", exact: true })
    .waitFor();
  assert.equal(git(repository, "branch", "--show-current"), "feature/ui");
  check("branch picker preserves dirty files and switches a clean checkout");

  // main.ts is retained across both branches and attributed to this session.
  await page
    .locator(".ws-project-section")
    .filter({ has: page.getByRole("button", { name: /^产出文件/ }) })
    .locator('.ws-row[title="main.ts"]')
    .click();
  await page.locator(".workspace-viewer-header").waitFor();
  const island = await page.locator(".workbench-header").boundingBox();
  const viewer = await page.locator(".workspace-viewer-header").boundingBox();
  assert(
    island && viewer && viewer.y >= island.y + island.height,
    "viewer toolbar must be below island",
  );
  await page
    .locator(".code-viewer")
    .getByText(/feature/)
    .first()
    .waitFor();
  await page.screenshot({ path: path.join(output, "05-file-viewer.png") });
  await page.getByRole("tab", { name: "Work", exact: true }).click();
  await page.locator(".workspace-viewer-header").waitFor({ state: "detached" });
  await page
    .locator(".ws-project-section")
    .filter({ has: page.getByRole("button", { name: /^产出文件/ }) })
    .locator('.ws-row[title="main.ts"]')
    .click();
  await page.getByRole("button", { name: "返回对话", exact: true }).click();
  await page.locator(".workspace-viewer-header").waitFor({ state: "detached" });
  check(
    "viewer avoids island; Work and explicit Back both return to conversation",
  );

  await menu("theme:toggle");
  const dark = await page
    .locator("html")
    .evaluate((el) => el.classList.contains("dark"));
  await page.waitForFunction(() => {
    const input = document.querySelector(".goal-session-composer-shell");
    const rail = document.querySelector(".agent-command-rail-inner");
    return (
      input &&
      rail &&
      input.getBoundingClientRect().right <=
        rail.getBoundingClientRect().right + 1
    );
  });
  const frost = await page
    .locator(".goal-session-composer-shell")
    .evaluate((el) => ({
      background: getComputedStyle(el).backgroundColor,
      blur: getComputedStyle(el).backdropFilter,
    }));
  assert.match(frost.background, /0\.9[46]/);
  assert.match(frost.blur, /blur/);
  const headerFrost = await page
    .locator(".workbench-header .wh-pill")
    .first()
    .evaluate((el) => getComputedStyle(el, "::after").backdropFilter);
  assert.match(headerFrost, /blur/);
  await page.screenshot({
    path: path.join(output, dark ? "02-dark.png" : "02-light.png"),
  });
  await menu("theme:toggle");
  await page.screenshot({
    path: path.join(output, dark ? "03-light.png" : "03-dark.png"),
  });
  await menu("toggle:sidebar");
  assert.equal(
    await page
      .locator(".session-panel-host--left")
      .getAttribute("data-collapsed"),
    "true",
  );
  await menu("toggle:sidebar");
  await menu("workspace:refresh");
  check("native menu actions and dense frosted surfaces in both themes");

  // Outline-only Wiki must not expose workflow navigation; generated content must.
  db.prepare(
    `INSERT INTO wiki_snapshots (id,project_id,branch,head_commit_sha,working_tree_hash,status,document_ids_json,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    "e2e-wiki",
    projectId,
    "feature/ui",
    git(repository, "rev-parse", "HEAD"),
    "e2e",
    "outline_ready",
    '["e2e-doc"]',
    stamp,
    "system",
  );
  db.prepare(
    `INSERT INTO wiki_documents (id,snapshot_id,project_id,title,doc_type,sort_order,created_at,updated_at,content_md,is_section) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "e2e-doc",
    "e2e-wiki",
    projectId,
    "Overview",
    "landscape",
    0,
    stamp,
    stamp,
    "",
    0,
  );
  await page.reload();
  await page.locator(".workspace-dashboard--pinned").waitFor();
  assert.equal(await page.getByRole("button", { name: /Workflow/ }).count(), 0);
  db.prepare(
    "UPDATE wiki_snapshots SET status='ready' WHERE id='e2e-wiki'",
  ).run();
  db.prepare(
    "UPDATE wiki_documents SET content_md='# Generated overview' WHERE id='e2e-doc'",
  ).run();
  await page.reload();
  await page.getByRole("button", { name: /Workflow/ }).waitFor();
  check("Workflow shortcut distinguishes outline-only from generated Wiki");

  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(900, 650),
  );
  await assertTranscriptClearsIsland();
  await page.locator(".work-details-trigger").waitFor();
  await page.locator(".work-details-trigger").click();
  await page.locator(".work-details-dialog").waitFor();
  await page.waitForFunction(() =>
    [
      ...document.querySelectorAll(
        ".work-details-dialog .workspace-dashboard--pinned > .bui-processes > .ws-card-body, .work-details-dialog .workspace-projects-pane > .ws-card > .ws-card-body",
      ),
    ].every((el) => el.getBoundingClientRect().height > 60),
  );
  assert.equal(
    await page
      .locator("html")
      .evaluate((el) => el.scrollWidth > window.innerWidth),
    false,
  );
  await page.screenshot({ path: path.join(output, "04-narrow.png") });
  await page.keyboard.press("Escape");
  check(
    "narrow desktop switches to a reachable details panel without horizontal overflow",
  );
  if (process.platform === "darwin") {
    const drag = await page.locator(".workbench-shell").evaluate((el) => ({
      left: getComputedStyle(el, "::before").left,
      button: getComputedStyle(
        document.querySelector(".session-list-titlebar-row button")!,
      ).getPropertyValue("-webkit-app-region"),
    }));
    assert.equal(drag.left, "80px");
    assert.equal(drag.button, "no-drag");
    check(
      "macOS native traffic-light exclusion and clickable titlebar controls",
    );
  }
  if (process.env.SYNAX_E2E_TERMINAL === "1") {
    const { terminalE2E } = await import("./terminal-e2e-checks");
    await terminalE2E({ desktop, page, repository, sessionId: session.id, projectId, output, check });
  }
  if (process.env.SYNAX_E2E_NATIVE_CHECK === "1") {
    await desktop.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setContentSize(1100, 760);
      win.setTitle("Synax E2E Native");
      win.show();
    });
    await writeFile(
      path.join(output, "native-ready.json"),
      JSON.stringify({
        stage: "minimize",
        executablePath,
        pid: desktop.process().pid,
      }),
    );
    console.log("NATIVE READY: minimize only the Synax E2E Native test window");
    const deadline = Date.now() + 240_000;
    while (
      !(await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.isMinimized(),
      ))
    ) {
      if (Date.now() > deadline)
        throw new Error("Native minimize was not verified before timeout");
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    check("native yellow traffic-light click really minimizes the test window");
    await desktop.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.restore();
      win.setTitle("Synax E2E Native");
    });
    await writeFile(
      path.join(output, "native-ready.json"),
      JSON.stringify({
        stage: "close",
        executablePath,
        pid: desktop.process().pid,
      }),
    );
    console.log("NATIVE READY: close only the Synax E2E Native test window");
    while (
      await desktop.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length > 0,
      )
    ) {
      if (Date.now() > deadline)
        throw new Error("Native close was not verified before timeout");
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    check("native red traffic-light click really closes the test window");
  }
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ passed, errors, date: new Date().toISOString() }, null, 2),
  );
  await rm(path.join(output, "failure.png"), { force: true });
  console.log(`WORKBENCH E2E PASSED: ${passed.length} checks`);
} catch (error) {
  await page
    ?.screenshot({ path: path.join(output, "failure.png") })
    .catch(() => {});
  logs += `\n${await page
    ?.locator("body")
    .innerText()
    .catch(() => "")}\n${error instanceof Error ? error.stack : String(error)}`;
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ passed, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  await stopServices?.();
  closeDb?.();
  await desktop?.close();
  await writeFile(path.join(output, "run.log"), logs);
  await rm(path.join(output, "native-ready.json"), { force: true });
  await rm(temp, { recursive: true, force: true });
}
