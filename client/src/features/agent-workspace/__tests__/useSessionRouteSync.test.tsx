import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { useSessionRouteSync } from "../useSessionRouteSync";
import { useAgentSessionStore as store } from "../state/agentSessionStore";
import { agentRuntimeApi, type AgentSession } from "../../../adapters/transport/agentRuntime";

vi.mock("../../../adapters/transport/sessionLiveClient", () => ({
  ensureSessionLiveSubscription: vi.fn(), releaseSessionLiveSubscription: vi.fn(),
}));

function Route({ workflow = false }: { workflow?: boolean }) {
  const navigate = useNavigate();
  useSessionRouteSync(workflow ? "workflow" : "sessions", "p");
  const selected = store(state => state.selectedSessionId);
  return <>
    <span>{selected}</span>
    {['ars_a', 'ars_b'].map(id => <button key={id} onClick={() => navigate(`/projects/p/sessions${workflow ? '/workflows' : ''}?session=${id}`)}>{id}</button>)}
  </>;
}

beforeEach(() => {
  const sessions = ['ars_a', 'ars_b'].map(id => ({ id, projectId: 'p', status: 'completed', activeRunId: null,
    sessionMetadata: { historyStorage: 3 }, updatedAt: '2026-10-28T01:00:00Z' } as AgentSession));
  const pages = Object.fromEntries(sessions.map(session => [session.id, {
    runs: [], steps: [], messages: [], toolCalls: [], events: [], permissions: [],
    sessionStats: null, sessionTodos: [], sessionInvocationUsage: null, cachedAt: Date.now() - 24 * 60 * 60 * 1000,
  }]));
  store.setState({ ...store.getInitialState(), projectId: 'p', sessions, sessionListTotal: 2, sessionDetailCache: pages });
});
afterEach(() => { store.setState(store.getInitialState()); vi.restoreAllMocks(); });

it.each([false, true])("keeps cached route navigation hot (workflow=%s)", async workflow => {
  const refresh = vi.spyOn(store.getState(), 'refreshDetail');
  const history = vi.spyOn(agentRuntimeApi, 'historyWindow');
  render(<MemoryRouter initialEntries={[`/projects/p/sessions${workflow ? '/workflows' : ''}?session=ars_a`]}><Route workflow={workflow} /></MemoryRouter>);
  expect(store.getState().selectedSessionId).toBe('ars_a');
  fireEvent.click(screen.getByRole('button', { name: 'ars_b' }));
  expect(store.getState().selectedSessionId).toBe('ars_b');
  fireEvent.click(screen.getByRole('button', { name: 'ars_a' }));
  await act(async () => {});
  expect(store.getState().selectedSessionId).toBe('ars_a');
  expect(store.getState().detailLoading).toBe(false);
  expect(store.getState().detailRefreshing).toBe(false);
  expect(refresh).not.toHaveBeenCalled();
  expect(history).not.toHaveBeenCalled();
});
