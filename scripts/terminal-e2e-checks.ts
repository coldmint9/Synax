import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ElectronApplication, Page } from 'playwright-core';

export async function terminalE2E({ desktop, page, repository, sessionId, projectId, output, check }: {
  desktop: ElectronApplication; page: Page; repository: string; sessionId: string; projectId: string; output: string; check: (label: string) => void;
}) {
  const details = page.locator('.work-details-dialog');
  try { await details.waitFor({ state: 'detached', timeout: 1000 }); }
  catch { await details.getByRole('button').first().click(); await details.waitFor({ state: 'detached' }); }
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await page.locator('.session-workspace-sidebar--dock').waitFor();
  const api = async (route: string, method = 'GET', body?: unknown) => page.evaluate(async ({ route, method, body }) => {
    const bridge = (window as any).electronAPI;
    const response = await fetch(`http://127.0.0.1:${await bridge.getApiPort()}/api/terminals${route}`, { method,
      headers: { Authorization: `Bearer ${await bridge.getRuntimeToken()}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { route, method, body });
  const until = async (test: () => Promise<boolean>, message: string, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (!(await test())) { if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 100)); }
  };
  const active = () => page.locator('.terminal-screen:not([hidden])');
  const text = async () => active().locator('.xterm-accessibility-tree').innerText();
  const send = async (value: string, enter = true) => {
    await active().locator('.terminal-connection--connected').waitFor();
    const input = active().locator('textarea.xterm-helper-textarea');
    await until(() => input.evaluate(element => !element.readOnly), 'active terminal input remained read-only');
    await input.focus();
    await input.evaluate((element, value) => {
      const clipboard = new DataTransfer(); clipboard.setData('text/plain', value);
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
    }, value);
    if (enter) await input.press('Enter');
  };
  const fileContains = async (file: string, value: string) => { try { return (await readFile(path.join(repository, file), 'utf8')).includes(value); } catch { return false; } };
  const prompt = () => until(async () => /[%#$>]\s*$/.test((await text()).trimEnd()), 'interactive shell prompt did not become ready');

  // Legacy records must open a truthful, inert migration view before any restart.
  const legacy = page.locator('.session-workspace-sidebar--dock .bui-process-command').filter({ hasText: 'a-very-long-background-service-command-0' });
  await legacy.click();
  await page.getByText('此服务尚未接入交互终端', { exact: true }).waitFor();
  let listed = (await api(`/projects/${projectId}`)).body.items as any[];
  const beforeLegacy = listed.length;
  assert.equal((await api(`/projects/${projectId}`)).body.items.length, beforeLegacy);
  await page.getByRole('textbox', { name: '重启命令', exact: true }).fill("printf 'MIGRATED_%s\\n' SERVICE");
  await page.getByRole('textbox', { name: '重启工作目录', exact: true }).fill(repository);
  await page.getByRole('button', { name: '确认并在终端重新运行', exact: true }).click();
  await active().locator('.terminal-connection--closed').waitFor();
  await until(async () => (await text()).includes('MIGRATED_SERVICE'), 'migrated service output not rendered');
  check('legacy service opens without execution and only restarts after explicit confirmation');

  await page.locator('.bui-process-new').click();
  await active().locator('.terminal-connection--connected').waitFor();
  const firstId = await active().getAttribute('data-terminal-id');
  assert(firstId);
  const first = (await api(`/projects/${projectId}/${firstId}`)).body;
  await prompt();
  await send("printf 'NATIVE_%s\\n' TTY; test -t 0 && printf 'TTY_%s\\n' OK; printf '中文🙂\\n'; pwd > terminal-cwd.txt; echo $$ > terminal-pid.txt");
  await until(async () => await fileContains('terminal-cwd.txt', repository), 'shell did not start in the selected workspace');
  await until(async () => (await text()).includes('TTY_OK') && (await text()).includes('中文🙂'), 'TTY/Unicode output not rendered');
  const shellPid = Number((await readFile(path.join(repository, 'terminal-pid.txt'), 'utf8')).trim());
  assert.equal(first.pid, shellPid);
  const drawer = await page.getByRole('region', { name: '终端抽屉' }).boundingBox();
  const viewSize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert(drawer && drawer.x <= 1 && drawer.width >= viewSize.width - 2 && drawer.y + drawer.height <= viewSize.height + 1);
  check('new terminal is a real TTY in the correct directory, with Unicode and full-width bottom layout');

  await send("sh -c 'printf ready > terminal-sleep-ready.txt; exec sleep 60'");
  await until(() => fileContains('terminal-sleep-ready.txt', 'ready'), 'foreground command did not start');
  await active().locator('textarea.xterm-helper-textarea').press('Control+C');
  await prompt();
  await send("printf 'after-interrupt' > terminal-interrupt.txt");
  await until(() => fileContains('terminal-interrupt.txt', 'after-interrupt'), 'Ctrl+C did not return control to the same shell');
  assert.equal((await api(`/projects/${projectId}/${firstId}`)).body.pid, shellPid);
  check('Ctrl+C interrupts the foreground command without killing the shell');
  await writeFile(path.join(repository, 'completion-target.txt'), 'TAB_COMPLETION_OK\n');
  await prompt();
  await send('cat completion-targ', false);
  await active().locator('textarea.xterm-helper-textarea').press('Tab');
  await active().locator('textarea.xterm-helper-textarea').press('Enter');
  await until(async () => (await text()).includes('TAB_COMPLETION_OK'), 'shell filename completion did not work');
  await prompt();
  await active().locator('textarea.xterm-helper-textarea').press('ArrowUp');
  await active().locator('textarea.xterm-helper-textarea').press('Enter');
  await until(async () => (await text()).split('TAB_COMPLETION_OK').length >= 3, 'shell history navigation did not replay the command');
  check('native shell Tab completion and history navigation remain available');


  await send('vi terminal-editor.txt');
  await until(async () => (await text()).includes('terminal-editor.txt') && ((await text()).includes('[New') || (await text()).includes('新文件')), 'vi did not enter the terminal screen');
  const editor = active().locator('textarea.xterm-helper-textarea');
  await editor.pressSequentially('iEdited through PTY'); await editor.press('Escape'); await editor.pressSequentially(':wq'); await editor.press('Enter');
  await until(() => fileContains('terminal-editor.txt', 'Edited through PTY'), 'full-screen editor did not save its file');
  check('full-screen vi editing and Escape operate inside the PTY');

  // Tab switching and drawer hiding keep the PTY and its shell environment alive.
  await page.locator('.terminal-drawer-actions').getByRole('button', { name: '新增终端', exact: true }).click();
  await active().locator('.terminal-connection--connected').waitFor();
  const secondId = await active().getAttribute('data-terminal-id'); assert(secondId && secondId !== firstId);
  await prompt();
  await send("printf 'second-shell' > terminal-second.txt");
  await until(() => fileContains('terminal-second.txt', 'second-shell'), 'second terminal did not execute');
  await page.getByRole('tab', { name: /终端 2 ·/ }).click();
  assert.equal(await active().getAttribute('data-terminal-id'), firstId);
  await page.getByRole('button', { name: '收起终端', exact: true }).click();
  assert.equal((await api(`/projects/${projectId}/${firstId}`)).body.state, 'active');
  await page.getByRole('button', { name: '终端', exact: true }).click();
  await active().locator('.terminal-connection--connected').waitFor();
  await send('echo $$ > terminal-resumed-pid.txt');
  await until(async () => Number((await readFile(path.join(repository, 'terminal-resumed-pid.txt'), 'utf8').catch(() => '0')).trim()) === shellPid, 'drawer reopen replaced the shell');
  check('terminal tabs and drawer hiding preserve the running shell and its state');

  const dimensionsBefore = (await api(`/projects/${projectId}/${firstId}`)).body;
  const resizer = page.getByRole('separator', { name: '调整终端高度' });
  const handle = await resizer.boundingBox(); assert(handle);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 3); await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y - 100, { steps: 8 }); await page.mouse.up();
  await until(async () => (await api(`/projects/${projectId}/${firstId}`)).body.rows !== dimensionsBefore.rows, 'resizing the drawer did not resize the PTY');
  const dimensionsAfter = (await api(`/projects/${projectId}/${firstId}`)).body;
  await send('stty size > terminal-size.txt');
  await until(() => fileContains('terminal-size.txt', `${dimensionsAfter.rows} ${dimensionsAfter.cols}`), 'terminal dimensions do not match the real TTY');
  await page.screenshot({ path: path.join(output, '06-terminal-drawer.png') });
  check('drawer resizing reaches the real PTY and leaves the rest of the page usable');

  // Closing a view is not process termination; reopening replays the retained output.
  await page.locator('.terminal-tab[data-active="true"]').getByRole('button', { name: /关闭终端视图/ }).click();
  assert.equal((await api(`/projects/${projectId}/${firstId}`)).body.state, 'active');
  await page.locator('.bui-process-row').filter({ has: page.locator(`[data-terminal-open="${firstId}"]`) }).locator('.bui-process-command').click();
  await active().locator('.terminal-connection--connected').waitFor();
  await until(async () => (await text()).includes('NATIVE_TTY'), 'reopened terminal did not replay its history');
  assert.equal((await api(`/projects/${projectId}/${firstId}`)).body.pid, shellPid);
  await prompt();
  await send("printf replay-safe > terminal-replay.txt");
  await until(() => fileContains('terminal-replay.txt', 'replay-safe'), 'historical terminal queries polluted the live shell');
  check('closing/reopening a terminal view reattaches without restarting the process');

  const program = "process.stdout.write('SERVICE_READY\\n');process.stdin.resume();process.stdin.on('data',data=>process.stdout.write('SERVICE_ECHO:'+data));setInterval(()=>{},1000)";
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const service = await api(`/sessions/${sessionId}/services`, 'POST', { command: `${quote(process.execPath)} -e ${quote(program)}`, cwd: repository, requestId: randomUUID() });
  assert.equal(service.status, 201);
  await page.locator(`[data-terminal-open="${service.body.id}"]`).click();
  await active().locator('.terminal-connection--connected').waitFor();
  await until(async () => (await text()).includes('SERVICE_READY'), 'background service output was not attached');
  await send('hello-service');
  await until(async () => (await text()).includes('SERVICE_ECHO:hello-service'), 'background service did not accept terminal input');
  await page.getByRole('button', { name: '结束终端', exact: true }).click();
  await active().locator('.terminal-connection--closed').waitFor();
  assert.equal((await api(`/projects/${projectId}/${service.body.id}`)).body.state, 'closed');
  check('new background services expose live PTY output and input in the same drawer');

  await page.getByRole('button', { name: '删除终端记录', exact: true }).click();
  assert.equal((await api(`/projects/${projectId}/${service.body.id}`)).status, 404);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 650));
  await page.locator('.work-details-trigger').click();
  await page.locator('.work-details-dialog').waitFor();
  await page.locator(`.work-details-dialog [data-terminal-open="${firstId}"]`).click();
  await page.locator('.work-details-dialog').waitFor({ state: 'detached' });
  await active().locator('.terminal-connection--connected').waitFor();
  assert.equal(await active().getAttribute('data-terminal-id'), firstId);
  await send("printf narrow > terminal-narrow.txt");
  await until(() => fileContains('terminal-narrow.txt', 'narrow'), 'narrow drawer input failed');
  assert.equal(await page.locator('html').evaluate(el => el.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, '07-terminal-narrow.png') });
  check('narrow-window service entry closes the details overlay and opens a usable terminal drawer');
  for (const id of [firstId, secondId]) assert.equal((await api(`/projects/${projectId}/${id}/stop`, 'POST')).status, 200);
  check('terminal stop/delete controls terminate owned processes and remove only selected records');
  await page.getByRole('button', { name: '收起终端', exact: true }).click();
}
