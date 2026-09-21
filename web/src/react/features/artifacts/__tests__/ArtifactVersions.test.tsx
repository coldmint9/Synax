import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { VersionActions } from "../ArtifactVersions";
import { artifactVersionsApi } from "../../../../lib/api/artifactVersions";
import type { ArtifactRevision } from "../../../../../../api/services/agent-runtime/artifacts/contracts";
vi.mock("../../../../lib/api/artifactVersions", () => ({
  artifactVersionsApi: {
    history: vi.fn(),
    fork: vi.fn(),
    inspectInheritance: vi.fn(),
    inheritState: vi.fn(),
  },
}));
vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "en" }),
}));
const one: ArtifactRevision = {
  type: "artifact",
  sessionId: "s",
  artifactId: "a",
  revisionId: "r1",
  title: "Demo",
  presentation: "inline",
  revisionNumber: 1,
  sourceKind: "html",
  sourcePath: "x.html",
  sourceHash: "s",
  bundleHash: "b",
  createdAt: "now",
  status: "ready",
  diagnostics: [],
  baseRevisionId: null,
  runId: null,
  turnId: null,
};
const two = {
  ...one,
  revisionId: "r2",
  revisionNumber: 2,
  baseRevisionId: "r1",
};
const fork = {
  ...one,
  artifactId: "branch",
  revisionId: "branch-r1",
  title: "Branch",
};
const state = {
  schemaVersion: 1,
  controls: { size: 3 },
  privateState: null,
  modelState: null,
  etag: 1,
};
const onForkPublished = vi.fn(),
  onStateInherited = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(artifactVersionsApi.history).mockResolvedValue({
    revisions: [two, one],
    derivedFrom: null,
    branches: [],
  });
  vi.mocked(artifactVersionsApi.fork).mockResolvedValue({ revision: fork });
  vi.mocked(artifactVersionsApi.inspectInheritance).mockResolvedValue({
    compatible: true,
    reason: null,
    sourceRevisionId: "r1",
    targetRevisionId: "r2",
    sourceEtag: 3,
    expectedEtag: 0,
    controlKeys: ["size"],
  });
  vi.mocked(artifactVersionsApi.inheritState).mockResolvedValue(state);
});
async function ready() {
  render(
    <VersionActions
      sessionId="s"
      reference={two}
      onForkPublished={onForkPublished}
      onStateInherited={onStateInherited}
    />,
  );
  await screen.findByRole("combobox", { name: "Source version" });
  fireEvent.change(screen.getByRole("combobox", { name: "Source version" }), {
    target: { value: "r1" },
  });
}
it("explicitly forks the selected historical version, not the live source or head; retry retains the request key", async () => {
  await ready();
  fireEvent.click(
    screen.getByRole("button", { name: "Branch from selected version" }),
  );
  expect(artifactVersionsApi.fork).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: "Branch title" }), {
    target: { value: "Historical branch" },
  });
  vi.mocked(artifactVersionsApi.fork).mockRejectedValueOnce(
    new Error("Connection lost"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Publish new branch" }));
  await screen.findByText("Connection lost");
  const first = vi.mocked(artifactVersionsApi.fork).mock.calls[0];
  expect(first).toEqual([
    "s",
    "r1",
    { title: "Historical branch", idempotencyKey: expect.any(String) },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Publish new branch" }));
  await waitFor(() => expect(onForkPublished).toHaveBeenCalledWith(fork));
  expect(vi.mocked(artifactVersionsApi.fork).mock.calls[1]).toEqual(first);
  expect(onStateInherited).not.toHaveBeenCalled();
});
it("reviews schemas before inheritance and only sends controls unless sensitive data is separately confirmed", async () => {
  await ready();
  fireEvent.click(
    screen.getByRole("button", { name: "Review state inheritance" }),
  );
  await screen.findByRole("button", { name: "Confirm state inheritance" });
  expect(artifactVersionsApi.inheritState).not.toHaveBeenCalled();
  expect(
    screen.getByRole("checkbox", { name: "Also copy private state" }),
  ).not.toBeChecked();
  expect(
    screen.getByRole("checkbox", { name: "Also copy model-visible state" }),
  ).not.toBeChecked();
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm state inheritance" }),
  );
  await waitFor(() => expect(onStateInherited).toHaveBeenCalledWith(state));
  expect(artifactVersionsApi.inheritState).toHaveBeenCalledWith("s", "r2", {
    sourceRevisionId: "r1",
    sourceEtag: 3,
    expectedEtag: 0,
    includePrivateState: false,
    includeModelState: false,
    confirmSensitiveState: false,
  });
});
it("requires the extra sensitive-state checkbox and leaves cancellation side-effect free", async () => {
  await ready();
  fireEvent.click(
    screen.getByRole("button", { name: "Review state inheritance" }),
  );
  await screen.findByRole("button", { name: "Confirm state inheritance" });
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Also copy model-visible state" }),
  );
  expect(
    screen.getByRole("button", { name: "Confirm state inheritance" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "I confirm copying the selected sensitive state",
    }),
  );
  expect(
    screen.getByRole("button", { name: "Confirm state inheritance" }),
  ).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(artifactVersionsApi.inheritState).not.toHaveBeenCalled();
});
it("rejects incompatible schemas and invalidates a stale review after a conflict", async () => {
  await ready();
  vi.mocked(artifactVersionsApi.inspectInheritance).mockResolvedValueOnce({
    compatible: false,
    reason: "Schemas do not match",
    sourceRevisionId: "r1",
    targetRevisionId: "r2",
    sourceEtag: 0,
    expectedEtag: 0,
    controlKeys: [],
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Review state inheritance" }),
  );
  await screen.findByText("Schemas do not match");
  expect(
    screen.queryByRole("button", { name: "Confirm state inheritance" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Review state inheritance" }),
  );
  await screen.findByRole("button", { name: "Confirm state inheritance" });
  vi.mocked(artifactVersionsApi.inheritState).mockRejectedValueOnce(
    new Error("STATE_CONFLICT: review again"),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm state inheritance" }),
  );
  await screen.findByText("STATE_CONFLICT: review again");
  expect(
    screen.queryByRole("button", { name: "Confirm state inheritance" }),
  ).not.toBeInTheDocument();
  expect(onStateInherited).not.toHaveBeenCalled();
});
it("shows lineage and ignores an in-flight old session response after unmount", async () => {
  vi.mocked(artifactVersionsApi.history).mockResolvedValue({
    revisions: [fork],
    derivedFrom: one,
    branches: [two],
  });
  let finish!: (value: { revision: ArtifactRevision }) => void;
  vi.mocked(artifactVersionsApi.fork).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(
    <VersionActions
      sessionId="s"
      reference={fork}
      onForkPublished={onForkPublished}
      onStateInherited={onStateInherited}
    />,
  );
  await screen.findByText(/Derived from: Demo · v1/);
  expect(screen.getByText(/Branches:/)).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Branch from selected version" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Publish new branch" }));
  view.unmount();
  await act(async () => finish({ revision: fork }));
  expect(onForkPublished).not.toHaveBeenCalled();
});
it("keeps a pending operation single-flight and ignores its completion after a session change", async () => {
  let finish!: (value: { revision: ArtifactRevision }) => void;
  vi.mocked(artifactVersionsApi.fork).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(
    <VersionActions
      sessionId="s"
      reference={two}
      onForkPublished={onForkPublished}
      onStateInherited={onStateInherited}
    />,
  );
  await screen.findByRole("combobox", { name: "Source version" });
  fireEvent.click(
    screen.getByRole("button", { name: "Branch from selected version" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Publish new branch" }));
  fireEvent.click(screen.getByRole("button", { name: "Publish new branch" }));
  expect(artifactVersionsApi.fork).toHaveBeenCalledTimes(1);
  view.rerender(
    <VersionActions
      sessionId="another-session"
      reference={two}
      onForkPublished={onForkPublished}
      onStateInherited={onStateInherited}
    />,
  );
  await act(async () => finish({ revision: fork }));
  expect(onForkPublished).not.toHaveBeenCalled();
});
