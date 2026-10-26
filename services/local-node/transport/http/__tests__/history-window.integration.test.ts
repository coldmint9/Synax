import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { agentRuntimeRoutes } from '../agent-runtime.js';
import { RustRuntimeSupervisor } from '../../../infrastructure/runtime/rust-sidecar.js';
import { RuntimeSidecarClient } from '../../../modules/agent-runtime/sidecar/sidecar-client.js';
import type { RuntimeFacade } from '../../../modules/agent-runtime/sidecar/runtime-facade.js';
import { runtimeFacade } from '../../../modules/agent-runtime/sidecar/runtime-facade.js';

type Window = Awaited<ReturnType<RuntimeFacade['historyWindowAuthoritative']>>;
let root: string;
let supervisor: RustRuntimeSupervisor;
let client: RuntimeSidecarClient;

async function start() {
  supervisor = new RustRuntimeSupervisor({ dataRoot: root });
  await supervisor.start();
  client = new RuntimeSidecarClient({ socketPath: supervisor.socketPath, token: supervisor.token });
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'synax-history-window-'));
  await start();
}, 30_000);

afterAll(async () => {
  client?.close();
  await supervisor?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function append(sessionId: string, objects: Array<{ kind: string; value: unknown }>) {
  await client.historyCommand({ sessionId, requestId: randomUUID(), operation: 'append_entities', payload: { objects } });
}

async function windowPage(sessionId: string, query: Record<string, string> = {}): Promise<Window> {
  const response = await agentRuntimeRoutes.request(`/sessions/${sessionId}/history-window?${new URLSearchParams(query)}`);
  const page = await response.json();
  expect(response.status, JSON.stringify(page).slice(0, 200)).toBe(200);
  return page as Window;
}

it('hydrates large context, step and tool records through the HTTP route across turns and restart', async () => {
  const id = 'history-large';
  const createdAt = '2026-10-21T00:00:00.000Z';
  await client.seedUi(id, Buffer.from(JSON.stringify({
    id, projectId: 'fixture', profileId: 'synax', status: 'completed',
    activeRunId: null, updatedAt: createdAt, createdAt, sessionMetadata: {},
  })));
  const content = '长系统上下文🙂\n'.repeat(6000);
  const message = (n: number, role: string, text: string) => ({
    id: `m${n}`, sessionId: id, runId: 'r', stepId: null,
    role, content: text, metadata: {}, sequence: n, createdAt,
  });
  const system = message(0, 'system', content);
  await append(id, [
    { kind: 'runtime.message', value: system },
    { kind: 'runtime.message', value: message(1, 'user', 'First question') },
    { kind: 'runtime.message', value: message(2, 'assistant', 'First answer') },
    { kind: 'runtime.run', value: { id: 'r', sessionId: id, status: 'completed', startedAt: createdAt, metadata: {} } },
    { kind: 'runtime.step', value: { id: 'step', sessionId: id, runId: 'r', index: 1, status: 'completed', startedAt: createdAt, metadata: { thought: content } } },
    { kind: 'runtime.tool_call', value: { id: 'tool', sessionId: id, runId: 'r', stepId: 'step', toolId: 'file.read', status: 'completed', startedAt: createdAt, outputSummary: content } },
  ]);

  const initial = await windowPage(id);
  expect(initial.messages.find(item => item.id === system.id)).toEqual(system);
  expect(initial.steps[0].metadata).toEqual({ thought: content });
  expect(initial.toolCalls[0].outputSummary).toBe(content);
  expect(initial.runs[0].id).toBe('r');
  expect((await windowPage(id, { since: initial.historyWindow.syncCursor! })).messages).toEqual([]);

  await append(id, [
    { kind: 'runtime.message', value: message(3, 'user', 'Second question') },
    { kind: 'runtime.message', value: message(4, 'assistant', content) },
  ]);
  const changed = await windowPage(id, { since: initial.historyWindow.syncCursor! });
  expect(changed.historyWindow.incremental).toBe(true);
  expect(changed.messages.map(item => item.id)).toEqual(['m3', 'm4']);
  expect(changed.messages[1].content).toBe(content);
  expect(changed.historyWindow.generation).toBe(initial.historyWindow.generation);

  // Reopening the app must retain the same history and a usable sync cursor.
  client.close();
  await supervisor.stop();
  await start();
  const reopened = await windowPage(id);
  expect(reopened.messages).toHaveLength(5);
  expect(reopened.messages.find(item => item.id === system.id)?.content).toBe(content);
  expect((await windowPage(id, { since: changed.historyWindow.syncCursor! })).messages).toEqual([]);
  await append(id, [{ kind: 'runtime.message', value: message(5, 'assistant', 'Third answer') }]);
  expect((await windowPage(id, { since: changed.historyWindow.syncCursor! })).messages.map(item => item.id)).toEqual(['m5']);
}, 30_000);

it('returns all multi-page changes without rereading old history or regressing an updated reply', async () => {
  const id = 'history-paged';
  await client.seedUi(id, Buffer.from(JSON.stringify({
    id, projectId: 'fixture', profileId: 'synax', status: 'completed',
    updatedAt: '2026-10-21T00:00:00.000Z',
  })));
  let page = await windowPage(id);
  await append(id, Array.from({ length: 30 }, (_, n) => ({ kind: 'runtime.message', value: {
    id: `m${n}`, sessionId: id, sequence: n, role: 'assistant', content: `Answer ${n}`, metadata: {},
  } })));
  let cursor = page.historyWindow.syncCursor!;
  const ids: string[] = [];
  for (let n = 0; n < 3; n++) {
    page = await windowPage(id, { since: cursor });
    ids.push(...page.messages.map(item => item.id));
    expect(page.historyWindow.syncCursor).not.toBe(cursor);
    cursor = page.historyWindow.syncCursor!;
    if (!page.historyWindow.hasMoreChanges) break;
  }
  expect(new Set(ids).size).toBe(30);
  expect(ids).toHaveLength(30);
  expect(page.historyWindow.hasMoreChanges).toBe(false);
  expect((await windowPage(id, { since: cursor })).messages).toEqual([]);
  await append(id, [{ kind: 'runtime.message', value: {
    id: 'm0', sessionId: id, sequence: 0, role: 'assistant', content: 'Updated answer', metadata: {},
  } }]);
  expect((await windowPage(id, { since: cursor })).messages).toMatchObject([{ id: 'm0', content: 'Updated answer' }]);
}, 30_000);

it('omits provider replay payloads from UI windows while keeping source history intact', async () => {
  const id = 'history-ui-projection';
  await client.seedUi(id, Buffer.from(JSON.stringify({ id, projectId: 'fixture', profileId: 'synax', status: 'completed', updatedAt: 'now' })));
  const content = 'Saved reply';
  const replay = { role: 'assistant', content: 'provider-only'.repeat(25_000) };
  await append(id, [{ kind: 'runtime.message', value: { id: 'small', sessionId: id, sequence: 1, role: 'assistant', content,
    metadata: { source: 'native', rustMessage: replay } } },
    { kind: 'runtime.message', value: { id: 'large', sessionId: id, sequence: 2, role: 'assistant', content: '原文🙂'.repeat(15_000),
      metadata: { source: 'native', rustMessage: replay } } }]);
  const page = await windowPage(id);
  expect(page.messages.find(message => message.id === 'small')).toMatchObject({ content, metadata: { source: 'native' } });
  expect(page.messages.every(message => !message.metadata.rustMessage)).toBe(true);
  expect(page.messages.find(message => message.id === 'large')?.content).toBe('原文🙂'.repeat(15_000));
  const original = JSON.parse(Buffer.from(await client.historyCommand({sessionId:id,requestId:randomUUID(),operation:'context_prompt',
    payload:{fromRevision:0,throughRevision:page.historyWindow.revision,generation:page.historyWindow.generation,tokenBudget:10_000_000}})).toString());
  expect(original.items[0].$historyObject).toBeTruthy();
  const first = await runtimeFacade.messageContentAuthoritative(id, 'large', 0, page.historyWindow.revision);
  expect(first.text).toBe('原文🙂'.repeat(15_000).slice(0, first.text.length));
  const second = await runtimeFacade.messageContentAuthoritative(id, 'large', first.next!, page.historyWindow.revision);
  expect(first.text + second.text).toBe('原文🙂'.repeat(15_000).slice(0, first.text.length + second.text.length));
  await expect(runtimeFacade.messageContentAuthoritative(id, 'large', first.next!, 0)).rejects.toMatchObject({code:'HISTORY_STALE'});
}, 30_000);
