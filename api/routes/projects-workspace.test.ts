import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from './projects.js';
import type { ProjectWorkspaceRoot } from '../services/project-workspace.js';

const isolation = vi.hoisted(() => ({
  dataRoot: '', listSessions: vi.fn(), listGitWorkspaces: vi.fn(),
  createGitWorktree: vi.fn(), removeGitWorktree: vi.fn(), pruneGitWorktrees: vi.fn(),
}));

// Keep the real route, directory validation and JSON store; isolate unrelated services.
vi.mock('../lib/env.js', () => ({
  get DATA_ROOT() {
    if (!isolation.dataRoot) throw new Error('Temporary DATA_ROOT must be set before importing projects');
    return isolation.dataRoot;
  },
}));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../services/context/context-service.js', () => ({ contextService: {} }));
vi.mock('../db/index.js', () => ({ getRawSqlite: vi.fn() }));
vi.mock('../services/agent-runtime/session-store.js', () => ({ agentRuntimeStore: { listSessions: isolation.listSessions } }));
vi.mock('../services/git-workspaces.js', () => ({
  GitWorkspaceError: class extends Error { constructor(message: string, public status: number) { super(message); } },
  createGitWorktree: isolation.createGitWorktree,
  listGitWorkspaces: isolation.listGitWorkspaces,
  pruneGitWorktrees: isolation.pruneGitWorktrees,
  removeGitWorktree: isolation.removeGitWorktree,
}));

let tempDir = '';
let projectsFile: string;
let mainPath: string;
let localPath: string;
let secondPath: string;
let existingPath: string;
let indirectPath: string;
let routes: typeof import('./projects.js')['projectRoutes'];

function directory(name: string): string {
  const target = path.join(tempDir, 'workspaces', name);
  fs.mkdirSync(target, { recursive: true });
  return fs.realpathSync(target);
}

function project(id: string, localWorkspace?: string): ProjectRecord {
  return {
    id, name: `Project ${id}`, status: 'healthy', environment: 'development',
    healthScore: 100, activeAgents: 0, activeHumans: 0, openRisks: 0,
    updatedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'test',
    ...(localWorkspace ? { source: { kind: 'localPath' as const, localPath: localWorkspace } } : {}),
  };
}

function diskProjects(): ProjectRecord[] {
  return (JSON.parse(fs.readFileSync(projectsFile, 'utf8')) as { items: ProjectRecord[] }).items;
}

function diskProject(id = 'main'): ProjectRecord {
  const record = diskProjects().find(item => item.id === id);
  expect(record).toBeDefined();
  return record!;
}

async function workspace(id = 'main'): Promise<ProjectWorkspaceRoot[]> {
  const response = await routes.request(`/${id}/workspace`);
  expect(response.status).toBe(200);
  return (await response.json() as { roots: ProjectWorkspaceRoot[] }).roots;
}

function postReference(body: unknown, id = 'main') {
  return routes.request(`/${id}/references`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function addReference(body: { localPath: string; name?: string } | { projectId: string }, id = 'main') {
  const response = await postReference(body, id);
  expect(response.status).toBe(201);
  return (await response.json() as { roots: ProjectWorkspaceRoot[] }).roots;
}

function expectPersistedReferences(roots: ProjectWorkspaceRoot[]) {
  expect(diskProject().references).toEqual(roots.filter(root => root.role === 'reference').map(root => ({
    id: root.id, name: root.name, localPath: root.path,
  })));
}

async function expectRejected(body: unknown, status = 400, id = 'main') {
  const beforeDisk = fs.readFileSync(projectsFile, 'utf8');
  const beforeRoots = await workspace();
  const response = await postReference(body, id);
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: expect.any(String) });
  expect(fs.readFileSync(projectsFile, 'utf8')).toBe(beforeDisk);
  expect(await workspace()).toEqual(beforeRoots);
}

beforeEach(async () => {
  vi.clearAllMocks();
  isolation.listSessions.mockReturnValue([]);
  isolation.listGitWorkspaces.mockResolvedValue({ branches: [], worktrees: [] });
  isolation.createGitWorktree.mockResolvedValue({ path: '/test/worktree' });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-projects-workspace-'));
  isolation.dataRoot = path.join(tempDir, 'data');
  fs.mkdirSync(isolation.dataRoot);
  vi.stubEnv('DATA_ROOT', isolation.dataRoot);
  mainPath = directory('main');
  localPath = directory('local');
  secondPath = directory('second');
  existingPath = directory('existing');
  indirectPath = directory('indirect');
  projectsFile = path.join(isolation.dataRoot, 'projects.json');
  fs.writeFileSync(projectsFile, JSON.stringify({ items: [
    project('main', mainPath), // Legacy record intentionally has no references property.
    { ...project('existing', existingPath), references: [
      { id: 'indirect-reference', name: 'Indirect dependency', localPath: indirectPath },
    ] },
    project('without-workspace'),
  ] }));
  vi.resetModules();
  ({ projectRoutes: routes } = await import('./projects.js'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
  isolation.dataRoot = '';
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('workspace creation and repository selection API', () => {
  function createWorkspace(body: unknown) {
    return routes.request('/workspaces', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  }

  it('creates and reloads a named workspace from local and registered projects in selection order', async () => {
    const existingBefore = diskProject('existing');
    const response = await createWorkspace({ name: 'Team workspace', roots: [
      { localPath, name: 'API' }, { projectId: 'existing' }, { localPath: secondPath, name: 'Web' },
    ] });
    expect(response.status).toBe(201);
    const body = await response.json() as { project: ProjectRecord; roots: ProjectWorkspaceRoot[] };
    expect(body.project).toMatchObject({ name: 'Team workspace', primaryName: 'API', source: { localPath } });
    expect(body.roots.map(({ name, path: rootPath, role }) => ({ name, path: rootPath, role }))).toEqual([
      { name: 'API', path: localPath, role: 'primary' },
      { name: 'Project existing', path: existingPath, role: 'reference' },
      { name: 'Web', path: secondPath, role: 'reference' },
    ]);
    expect(new Set(body.roots.map(root => root.id)).size).toBe(3);
    expect(diskProject('existing')).toEqual(existingBefore);
    expect(diskProject(body.project.id)).toEqual(body.project);
    vi.resetModules();
    ({ projectRoutes: routes } = await import('./projects.js'));
    expect(await workspace(body.project.id)).toEqual(body.roots);
  });

  it.each(['duplicate', 'overlap', 'symlink', 'missing', 'unknown project', 'no directory', 'empty', 'mixed selector'])(
    'rejects %s selections without publishing a partial workspace', async kind => {
      const alias = path.join(tempDir, 'local-alias');
      fs.symlinkSync(localPath, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const invalidRoots: Record<string, unknown[]> = {
        duplicate: [{ localPath }, { localPath }],
        overlap: [{ localPath }, { localPath: path.dirname(localPath) }],
        symlink: [{ localPath }, { localPath: alias }],
        missing: [{ localPath }, { localPath: path.join(tempDir, 'missing') }],
        'unknown project': [{ localPath }, { projectId: 'unknown' }],
        'no directory': [{ localPath }, { projectId: 'without-workspace' }],
        empty: [],
        'mixed selector': [{ localPath, projectId: 'existing' }],
      };
      const diskBefore = fs.readFileSync(projectsFile, 'utf8');
      const listBefore = await (await routes.request('/')).json();
      const response = await createWorkspace({ name: 'Invalid', roots: invalidRoots[kind] });
      expect(response.status).toBe(kind === 'unknown project' ? 404 : 400);
      expect(fs.readFileSync(projectsFile, 'utf8')).toBe(diskBefore);
      expect(await (await routes.request('/')).json()).toEqual(listBefore);
    },
  );

  it('routes worktree reads and mutations to the selected member and counts sessions from every workspace', async () => {
    const roots = await addReference({ localPath });
    const rootId = roots[1].id;
    const worktreePath = directory('linked-worktree');
    const binding = { id: rootId, name: 'Linked', role: 'reference', status: 'available', path: worktreePath };
    isolation.listSessions.mockReturnValue([
      { projectId: 'another-workspace', sessionMetadata: { backend: { workDir: worktreePath, workspaceRoots: [binding] } } },
      { projectId: 'main', sessionMetadata: { backend: { workDir: mainPath, workspaceRoots: [binding] } } },
    ]);
    expect((await routes.request(`/main/git/workspaces?rootId=${rootId}`)).status).toBe(200);
    expect(isolation.listSessions).toHaveBeenCalledWith({ limit: Number.MAX_SAFE_INTEGER });
    expect(isolation.listGitWorkspaces).toHaveBeenLastCalledWith(localPath, `main/${rootId}`, new Map([[worktreePath, 2], [mainPath, 1]]));

    const create = await routes.request('/main/git/worktrees', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rootId, branch: 'feature', createBranch: true }),
    });
    expect(create.status).toBe(201);
    expect(isolation.createGitWorktree).toHaveBeenCalledWith(localPath, `main/${rootId}`, { rootId, branch: 'feature', createBranch: true });

    expect((await routes.request(`/main/git/worktrees/prune?rootId=${rootId}`, { method: 'POST' })).status).toBe(200);
    expect(isolation.pruneGitWorktrees).toHaveBeenCalledWith(localPath);
    const remove = await routes.request('/main/git/worktrees', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rootId, path: worktreePath, force: true }),
    });
    expect(remove.status).toBe(200);
    expect(isolation.removeGitWorktree).toHaveBeenCalledWith(localPath, `main/${rootId}`, worktreePath, {
      force: true, inUsePaths: new Set([worktreePath, mainPath]),
    });
  });

  it.each(['omitted', 'unknown'])('rejects an %s member before any worktree mutation', async kind => {
    await addReference({ localPath });
    const selector = kind === 'unknown' ? { rootId: 'unknown' } : {};
    const status = kind === 'unknown' ? 404 : 400;
    for (const method of ['POST', 'DELETE']) {
      const response = await routes.request('/main/git/worktrees', {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...selector, ...(method === 'POST' ? { branch: 'feature' } : { path: secondPath }) }),
      });
      expect(response.status).toBe(status);
    }
    expect((await routes.request(`/main/git/worktrees/prune${kind === 'unknown' ? '?rootId=unknown' : ''}`, { method: 'POST' })).status).toBe(status);
    expect(isolation.createGitWorktree).not.toHaveBeenCalled();
    expect(isolation.removeGitWorktree).not.toHaveBeenCalled();
    expect(isolation.pruneGitWorktrees).not.toHaveBeenCalled();
  });

  it('keeps single-member creation and implicit Git selection compatible', async () => {
    const response = await createWorkspace({ name: 'Solo', roots: [{ localPath }] });
    expect(response.status).toBe(201);
    const body = await response.json() as { project: ProjectRecord; roots: ProjectWorkspaceRoot[] };
    expect(body.roots).toHaveLength(1);
    expect((await routes.request(`/${body.project.id}/git/worktrees/prune`, { method: 'POST' })).status).toBe(200);
    expect(isolation.pruneGitWorktrees).toHaveBeenCalledWith(localPath);
  });
});

describe('project workspace references API', () => {
  it('returns only the primary root for a legacy single-directory project without changing its JSON', async () => {
    const before = fs.readFileSync(projectsFile, 'utf8');
    expect(await workspace()).toEqual([
      { id: 'main', name: 'Project main', path: mainPath, role: 'primary', status: 'available' },
    ]);
    expect(diskProject()).not.toHaveProperty('references');
    expect(fs.readFileSync(projectsFile, 'utf8')).toBe(before);
    expect(await workspace('without-workspace')).toEqual([]);
    expect((await routes.request('/unknown/workspace')).status).toBe(404);
  });

  it('persists several local and existing-project references without importing transitive references', async () => {
    const existingBefore = diskProject('existing');
    const first = await addReference({ localPath, name: 'Local library' });
    expect(first).toHaveLength(2);
    expectPersistedReferences(first);

    const second = await addReference({ projectId: 'existing' });
    expect(second).toHaveLength(3);
    expectPersistedReferences(second);

    const roots = await addReference({ localPath: secondPath });
    expect(roots).toEqual([
      { id: 'main', name: 'Project main', path: mainPath, role: 'primary', status: 'available' },
      { id: expect.any(String), name: 'Local library', path: localPath, role: 'reference', status: 'available' },
      { id: expect.any(String), name: 'Project existing', path: existingPath, role: 'reference', status: 'available' },
      { id: expect.any(String), name: path.basename(secondPath), path: secondPath, role: 'reference', status: 'available' },
    ]);
    expect(new Set(roots.map(root => root.id)).size).toBe(4);
    expect(roots.slice(0, 3)).toEqual(second);
    expect(roots.map(root => root.path)).not.toContain(indirectPath);
    expect(await workspace()).toEqual(roots);
    expectPersistedReferences(roots);
    expect(diskProject('existing')).toEqual(existingBefore);
  });

  it('reloads persisted memberships from JSON after the route module is reset', async () => {
    await addReference({ localPath });
    const roots = await addReference({ projectId: 'existing' });
    const previousRoutes = routes;
    const before = fs.readFileSync(projectsFile, 'utf8');
    vi.resetModules();
    ({ projectRoutes: routes } = await import('./projects.js'));
    expect(routes).not.toBe(previousRoutes);
    expect(await workspace()).toEqual(roots);
    expect(fs.readFileSync(projectsFile, 'utf8')).toBe(before);
    expectPersistedReferences(roots);
  });

  it('unbinds local and project references while preserving files, other memberships and the referenced project', async () => {
    const retainedFiles = [mainPath, localPath, existingPath, indirectPath].map((root, index) => {
      const file = path.join(root, 'keep.txt');
      const content = `keep workspace ${index}\n`;
      fs.writeFileSync(file, content);
      return { file, content };
    });
    const existingBefore = diskProject('existing');
    await addReference({ localPath });
    const roots = await addReference({ projectId: 'existing' });
    for (const reference of roots.filter(root => root.role === 'reference')) {
      const response = await routes.request(`/main/references/${reference.id}`, { method: 'DELETE' });
      expect(response.status).toBe(200);
      const expected = (reference.path === localPath ? roots.filter(root => root.id !== reference.id) : roots.slice(0, 1));
      expect(await response.json()).toEqual({ roots: expected });
      expect(await workspace()).toEqual(expected);
      expectPersistedReferences(expected);
      expect(diskProject('existing')).toEqual(existingBefore);
      for (const { file, content } of retainedFiles) expect(fs.readFileSync(file, 'utf8')).toBe(content);
    }
    vi.resetModules();
    ({ projectRoutes: routes } = await import('./projects.js'));
    expect(await workspace()).toEqual(roots.slice(0, 1));
    expect(diskProject().references).toEqual([]);
  });

  it.each(['main', 'unknown-reference'])('refuses to delete %s as a reference', async referenceId => {
    const roots = await addReference({ localPath });
    const before = fs.readFileSync(projectsFile, 'utf8');
    const response = await routes.request(`/main/references/${referenceId}`, { method: 'DELETE' });
    expect(response.status).toBe(404);
    expect(await workspace()).toEqual(roots);
    expect(fs.readFileSync(projectsFile, 'utf8')).toBe(before);
    expect(fs.statSync(mainPath).isDirectory()).toBe(true);
  });

  it('rejects repeated local paths, repeated project IDs and cross-form duplicates', async () => {
    await addReference({ localPath });
    await expectRejected({ localPath });
    await addReference({ projectId: 'existing' });
    await expectRejected({ projectId: 'existing' });
    await expectRejected({ localPath: existingPath });
  });

  it.each(['primary child', 'primary parent', 'reference child', 'reference parent'])(
    'rejects overlapping directories: %s', async kind => {
      const nestedReference = directory('reference-parent/child');
      await addReference({ localPath: nestedReference });
      const candidates: Record<string, string> = {
        'primary child': directory('main/child'),
        'primary parent': path.dirname(mainPath),
        'reference child': directory('reference-parent/child/nested'),
        'reference parent': path.dirname(nestedReference),
      };
      await expectRejected({ localPath: candidates[kind] });
    },
  );

  it.each(['primary', 'reference'])('rejects a symlink alias of the %s directory', async kind => {
    await addReference({ localPath });
    const alias = path.join(tempDir, `alias-${kind}`);
    fs.symlinkSync(kind === 'primary' ? mainPath : localPath, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expectRejected({ localPath: alias });
  });

  it.each(['missing', 'file', 'relative', 'empty', 'nul'])(
    'rejects an invalid directory: %s', async kind => {
      const file = path.join(tempDir, 'ordinary-file');
      fs.writeFileSync(file, 'not a directory');
      const candidates: Record<string, string> = {
        missing: path.join(tempDir, 'does-not-exist'), file, relative: 'relative/directory',
        empty: '   ', nul: `${localPath}\0invalid`,
      };
      await expectRejected({ localPath: candidates[kind] });
    },
  );

  it('rejects main-project self references by project ID and directory', async () => {
    await expectRejected({ projectId: 'main' });
    await expectRejected({ localPath: mainPath });
  });

  it('rejects missing projects and projects without a local workspace', async () => {
    await expectRejected({ projectId: 'unknown' }, 404);
    await expectRejected({ localPath }, 404, 'unknown');
    await expectRejected({ projectId: 'without-workspace' });
    await expectRejected({ localPath }, 400, 'without-workspace');
  });

  it('keeps every concurrent addition in both the current workspace and the reloaded JSON store', async () => {
    const bodies = [{ localPath }, { projectId: 'existing' }, { localPath: secondPath },
      { localPath: directory('concurrent-a') }, { localPath: directory('concurrent-b') }];
    const responses = await Promise.all(bodies.map(body => postReference(body)));
    expect(responses.map(response => response.status)).toEqual(bodies.map(() => 201));
    const roots = await workspace();
    const expectedPaths = [mainPath, localPath, existingPath, secondPath,
      path.join(tempDir, 'workspaces', 'concurrent-a'), path.join(tempDir, 'workspaces', 'concurrent-b')].map(p => fs.realpathSync(p));
    expect(roots.map(root => root.path).sort()).toEqual(expectedPaths.sort());
    expect(new Set(roots.map(root => root.id)).size).toBe(expectedPaths.length);
    expectPersistedReferences(roots);
    vi.resetModules();
    ({ projectRoutes: routes } = await import('./projects.js'));
    expect(await workspace()).toEqual(roots);
  });
});

describe("project store initialization", () => {
  async function reload() {
    vi.resetModules();
    ({ projectRoutes: routes } = await import("./projects.js"));
    const response = await routes.request("/");
    return (await response.json()) as { items: ProjectRecord[]; total: number };
  }

  it("starts empty without a data file and remains empty after restart", async () => {
    fs.unlinkSync(projectsFile);
    expect((await reload()).items).toEqual([]);
    expect(diskProjects()).toEqual([]);
    expect((await reload()).items).toEqual([]);
  });

  it("removes persisted default examples without removing real projects", async () => {
    const examples: ProjectRecord[] = [
      {
        ...project("rumbling-core"),
        name: "Rumbling Core",
        status: "at_risk",
        environment: "staging",
        healthScore: 72,
        activeAgents: 4,
        activeHumans: 2,
        openRisks: 2,
        updatedAt: "just now",
        createdBy: "alice",
      },
      {
        ...project("growth-ops"),
        name: "Growth Ops",
        environment: "production",
        healthScore: 89,
        activeAgents: 3,
        activeHumans: 1,
        updatedAt: "12m ago",
        createdBy: "alice",
      },
      {
        ...project("mobile-revamp"),
        name: "Mobile Revamp",
        status: "blocked",
        healthScore: 54,
        activeAgents: 2,
        activeHumans: 2,
        openRisks: 3,
        updatedAt: "8m ago",
        createdBy: "alice",
      },
    ];
    const desktop = { ...project("desktop", mainPath), name: "Desktop" };
    fs.writeFileSync(
      projectsFile,
      JSON.stringify({ items: [...examples, desktop] }),
    );
    expect((await reload()).items).toEqual([desktop]);
    expect(diskProjects()).toEqual([desktop]);
    expect((await reload()).items).toEqual([desktop]);

    // Identical names/IDs do not justify deleting imported or customized projects.
    const realProjects = [
      {
        ...examples[0],
        source: { kind: "localPath" as const, localPath: mainPath },
      },
      { ...examples[1], name: "My growth project" },
      { ...examples[2], references: [{ id: "ref", name: "Code", localPath }] },
    ];
    fs.writeFileSync(projectsFile, JSON.stringify({ items: realProjects }));
    expect((await reload()).items).toHaveLength(3);
    expect(diskProjects()).toEqual(realProjects);
  });
});
