vi.mock("../../../../lib/api/artifactVersions",()=>({artifactVersionsApi:{history:vi.fn(async()=>({revisions:[],derivedFrom:null,branches:[]}))}}));
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactCard } from "../ArtifactCard";
import { ArtifactControls } from "../ArtifactControls";
import { artifactsApi } from "../../../../lib/api/artifacts";
import { mountPreview } from "../transport";
const locale = vi.hoisted(() => ({ value: "en" }));
vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: locale.value }),
}));
vi.mock("../../../../lib/api/artifacts", () => ({
  artifactsApi: {
    bundle: vi.fn(),
    state: vi.fn(),
    revisions: vi.fn(),
    source: vi.fn(),
    feedback: vi.fn(),
    download: vi.fn(),
    saveState: vi.fn(),
  },
}));
vi.mock("../transport", () => ({
  desktopEnvironment: () => ({ desktop: false }),
  mountPreview: vi.fn(),
}));
const reference = {
  type: "artifact" as const,
  artifactId: "a",
  revisionId: "r",
  title: "Checkout prototype",
  presentation: "inline" as const,
};
const revision = {
  ...reference,
  sessionId: "s",
  revisionNumber: 1,
  sourceKind: "html" as const,
  sourcePath: "index.html",
  sourceHash: "s",
  bundleHash: "b",
  createdAt: "2026-09-21",
  status: "ready" as const,
  diagnostics: [],
  baseRevisionId: null,
  runId: null,
  turnId: null,
};
const state = {
  privateState: { secret: "PRIVATE_SECRET" },
  modelState: { page: "cart" },
  controls: { quantity: 2 },
  etag: 1,
  schemaVersion: 1,
};
beforeEach(() => {
  vi.clearAllMocks();
  locale.value = "en";
  vi.mocked(artifactsApi.bundle).mockResolvedValue({
    revision,
    html: "<html><head></head><body>Preview</body></html>",
  });
  vi.mocked(artifactsApi.state).mockResolvedValue(state);
  vi.mocked(artifactsApi.revisions).mockResolvedValue({ items: [revision] });
  vi.mocked(artifactsApi.source).mockResolvedValue({
    files: [
      {
        path: "index.html",
        content: "<button>hello</button>",
        encoding: "utf8",
        mediaType: "text/html",
      },
    ],
  });
  vi.mocked(artifactsApi.feedback).mockResolvedValue({
    feedbackId: "f",
    message: "queued",
    submitted: true,
  });
  vi.mocked(mountPreview).mockImplementation((options) => {
    options.onConnected();
    return { send: vi.fn(), destroy: vi.fn(), update: vi.fn() };
  });
});
async function ready() {
  render(<ArtifactCard sessionId="s" reference={reference} />);
  await screen.findByRole("button", { name: "Run interactive content" });
}
describe("artifact card", () => {
  it("does not run until opted in and exposes the Web limitations", async () => {
    await ready();
    expect(mountPreview).not.toHaveBeenCalled();
    expect(
      screen.getByText(/cannot guarantee complete network or CPU isolation/),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Run interactive content" }),
    );
    await waitFor(()=>expect(mountPreview).toHaveBeenCalled());
    expect(mountPreview).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Run interactive content" }),
      ).toBeVisible(),
    );
  });
  it("keeps drafts local and submits exactly once only after host confirmation, excluding private state", async () => {
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: "QA" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "What should change?" }),
      { target: { value: "Make checkout clearer" } },
    );
    expect(artifactsApi.feedback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review feedback" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("dialog").textContent).not.toContain(
      "PRIVATE_SECRET",
    );
    expect(artifactsApi.feedback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(artifactsApi.feedback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review feedback" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
    await screen.findByText("Feedback queued for the agent.");
    expect(artifactsApi.feedback).toHaveBeenCalledTimes(1);
    expect(artifactsApi.feedback).toHaveBeenCalledWith(
      "s",
      "r",
      expect.objectContaining({
        text: "Make checkout clearer",
        parameters: { quantity: 2 },
        modelState: { page: "cart" },
      }),
    );
    expect(
      JSON.stringify(vi.mocked(artifactsApi.feedback).mock.calls),
    ).not.toContain("PRIVATE_SECRET");
  });
  it("retains the idempotency key on retry after ambiguous submission failure", async () => {
    vi.mocked(artifactsApi.feedback).mockRejectedValueOnce(
      new Error("Connection lost"),
    );
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: "QA" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "What should change?" }),
      { target: { value: "Fix" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Review feedback" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Confirm and send" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
    await screen.findByText("Feedback queued for the agent.");
    const calls = vi.mocked(artifactsApi.feedback).mock.calls;
    expect(calls[0][2].idempotencyKey).toBe(calls[1][2].idempotencyKey);
  });
  it("shows source as text, supports export, and expands without remounting the preview", async () => {
    await ready();
    fireEvent.click(
      screen.getByRole("button", { name: "Run interactive content" }),
    );
    await waitFor(()=>expect(mountPreview).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Expand artifact" }));
    expect(mountPreview).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("tab", { name: "Source" }));
    expect(await screen.findByText("<button>hello</button>")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "HTML", exact: true }));
    await waitFor(() =>
      expect(artifactsApi.download).toHaveBeenCalledWith("s", "r", "html"),
    );
  });
  it("shows restore failures rather than running with an empty state", async () => {
    vi.mocked(artifactsApi.state).mockRejectedValue(
      new Error("Restore unavailable"),
    );
    render(<ArtifactCard sessionId="s" reference={reference} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Restore unavailable",
    );
    expect(mountPreview).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Run", exact: true }),
    ).toBeDisabled();
  });
  it("does not open a confirmation or submit when generated content requests a draft", async () => {
    await ready();
    fireEvent.click(
      screen.getByRole("button", { name: "Run interactive content" }),
    );
    await waitFor(()=>expect(mountPreview).toHaveBeenCalled());
    await act(async () => {
      await vi
        .mocked(mountPreview)
        .mock.calls[0][0].onRequest("feedbackDraft", {
          text: "Suggested change",
        });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(artifactsApi.feedback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "QA" }));
    expect(screen.getByRole("textbox")).toHaveValue("Suggested change");
  });
});
it("renders all declarative controls with accessible labels", () => {
  const onChange = vi.fn();
  render(
    <ArtifactControls
      controls={[
        {
          key: "enabled",
          label: "Enabled",
          type: "toggle",
          defaultValue: true,
        },
        {
          key: "size",
          label: "Size",
          type: "range",
          min: 1,
          max: 5,
          defaultValue: 2,
        },
        {
          key: "view",
          label: "View",
          type: "select",
          defaultValue: "a",
          options: [{ label: "A", value: "a" }],
        },
        { key: "name", label: "Name", type: "text", defaultValue: "Demo" },
        {
          key: "color",
          label: "Color",
          type: "color",
          defaultValue: "#ffffff",
        },
        { key: "count", label: "Count", type: "number", defaultValue: 2 },
      ]}
      values={{}}
      onChange={onChange}
    />,
  );
  for (const label of ["Enabled", "Size", "View", "Name", "Color", "Count"])
    expect(
      screen.getByLabelText(label, { selector: "input,select" }),
    ).toBeVisible();
  fireEvent.click(screen.getByLabelText("Enabled"));
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ key: "enabled" }),
    false,
  );
});

it("localizes the host actions and confirmation UI in Chinese", async () => {
  locale.value = "zh";
  render(<ArtifactCard sessionId="s" reference={reference} />);
  await screen.findByRole("button", { name: "运行交互内容" });
  expect(screen.getByRole("tab", { name: "预览" })).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "QA" }));
  fireEvent.change(screen.getByRole("textbox", { name: "希望如何修改？" }), {
    target: { value: "请调整间距" },
  });
  fireEvent.click(screen.getByRole("button", { name: "预审反馈" }));
  expect(
    screen.getByRole("dialog", { name: "向智能体发送反馈？" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "确认并发送" })).toBeVisible();
});

it("switches revisions without automatically running the selected version", async () => {
  const next = { ...revision, revisionId: "r2", revisionNumber: 2 };
  vi.mocked(artifactsApi.revisions).mockResolvedValue({
    items: [next, revision],
  });
  vi.mocked(artifactsApi.bundle).mockImplementation(async (_session, id) => ({
    revision: id === "r2" ? next : revision,
    html: "<html><head></head><body>Preview</body></html>",
  }));
  await ready();
  fireEvent.click(
    screen.getByRole("button", { name: "Run interactive content" }),
  );
  await waitFor(()=>expect(mountPreview).toHaveBeenCalled());
  const first = vi.mocked(mountPreview).mock.results[0].value;
  fireEvent.change(screen.getByRole("combobox", { name: "Artifact version" }), {
    target: { value: "r2" },
  });
  await screen.findByText(/v2 · HTML/);
  expect(first.destroy).toHaveBeenCalled();
  expect(mountPreview).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("button", { name: "Run interactive content" }),
  ).toBeVisible();
  expect(artifactsApi.state).toHaveBeenCalledWith("s", "r2");
});
it("shows a failed revision diagnostic and keeps execution disabled", async () => {
  vi.mocked(artifactsApi.bundle).mockResolvedValue({
    revision: {
      ...revision,
      status: "failed",
      diagnostics: ["Build rejected remote import."],
    },
    html: "",
  });
  render(<ArtifactCard sessionId="s" reference={reference} />);
  expect(
    await screen.findByText("Build rejected remote import."),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Run", exact: true }),
  ).toBeDisabled();
  expect(mountPreview).not.toHaveBeenCalled();
});
it("rejects malformed restored state before starting the SDK", async () => {
  vi.mocked(artifactsApi.state).mockResolvedValue({
    ...state,
    controls: [] as any,
  });
  render(<ArtifactCard sessionId="s" reference={reference} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Saved artifact state is invalid.",
  );
  expect(mountPreview).not.toHaveBeenCalled();
});
