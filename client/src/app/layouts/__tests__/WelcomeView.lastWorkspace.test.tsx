import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WelcomeView } from "../WelcomeView";
import {
  useShellStore,
  type ProjectSummary,
} from "../../../shared/state/shellStore";
import {
  clearLastOpenedWorkspaceId,
  saveLastOpenedWorkspaceId,
} from "../../../features/workspace/lastOpenedWorkspace";
import { clearSessionLastVisit } from "../../../features/agent-workspace/sessionLastVisit";
import { t } from "../../../shared/lib/i18n";

function project(id: string, updatedAt: string): ProjectSummary {
  return {
    id,
    name: id,
    status: "healthy",
    environment: "development",
    healthScore: 100,
    activeAgents: 0,
    activeHumans: 1,
    openRisks: 0,
    updatedAt,
  };
}

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Location />
      <Routes>
        <Route element={<Outlet context={{ onCreateProject: () => {} }} />}>
          <Route path="/" element={<WelcomeView />} />
          <Route path="*" element={null} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const PREVIOUS_STATE = useShellStore.getState();

beforeEach(() => {
  useShellStore.setState({
    projects: [project("ws-later", "2026-10-22T10:00:00.000Z"), project("ws-closed", "2026-10-01T10:00:00.000Z")],
    projectsLoaded: true,
    preferences: { ...PREVIOUS_STATE.preferences, defaultHome: "last-project" },
  });
});

afterEach(() => {
  // Unmount before resetting the shared store so the still-mounted view does
  // not re-render outside act().
  cleanup();
  clearLastOpenedWorkspaceId();
  clearSessionLastVisit("ws-later");
  clearSessionLastVisit("ws-closed");
  useShellStore.setState({
    projects: [],
    projectsLoaded: false,
    preferences: PREVIOUS_STATE.preferences,
  });
});

describe("startup landing", () => {
  it("routes back to the workspace that was open when the app closed", async () => {
    saveLastOpenedWorkspaceId("ws-closed");
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/projects/ws-closed/sessions",
      ),
    );
  });

  it("falls back to the most recently updated workspace without a remembered one", async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/projects/ws-later/sessions",
      ),
    );
  });

  it("stays on the global home when the setting asks for it", async () => {
    useShellStore.setState((state) => ({
      preferences: { ...state.preferences, defaultHome: "global-home" },
    }));
    saveLastOpenedWorkspaceId("ws-closed");
    mount();
    await waitFor(() =>
      expect(
        screen.getByText(t(PREVIOUS_STATE.preferences.locale, "appImportProject")),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
  });
});
