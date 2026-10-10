import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { agentRuntimeApi } from "../../../adapters/transport/agentRuntime";
import { MarkdownRenderer } from "../../../shared/ui/markdown/MarkdownRenderer";
import { SessionMarkdown } from "../SessionMarkdown";
import { TranscriptSessionProvider } from "../SessionTranscriptContext";
import { resolveMarkdownImage, useWorkspaceMarkdownImages } from "../WorkspaceMarkdownImage";

vi.mock("../../../adapters/transport/agentRuntime", () => ({
  agentRuntimeApi: { getSessionEnvironmentFileMedia: vi.fn() },
}));
const readMedia = vi.mocked(agentRuntimeApi.getSessionEnvironmentFileMedia);
const revoke = vi.fn();

beforeEach(() => {
  readMedia.mockReset().mockResolvedValue(new Blob(["image"], { type: "image/png" }));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test/image");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revoke);
  revoke.mockClear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(["screens/config.png", "/repo/screens/config.png", "file:///repo/screens/config.png"])("loads session image %s through the media API and previews it", async (src) => {
  const { unmount } = render(<TranscriptSessionProvider sessionId="session-1" workspacePath="/repo">
    <SessionMarkdown content={`![JSON 配置](${src})`} />
  </TranscriptSessionProvider>);
  expect(await screen.findByRole("img", { name: "JSON 配置" })).toHaveAttribute("src", "blob:test/image");
  expect(readMedia).toHaveBeenCalledWith("session-1", "screens/config.png", undefined);
  fireEvent.click(screen.getByRole("button", { name: "放大图片：JSON 配置" }));
  expect(screen.getByRole("dialog").querySelector("img")).toHaveAttribute("src", "blob:test/image");
  unmount();
  expect(revoke).toHaveBeenCalledWith("blob:test/image");
});

it("resolves reference-root images", async () => {
  render(<TranscriptSessionProvider sessionId="s" workspacePath="/repo" roots={[{ rootId: "ref", name: "ref", workspacePath: "/reference" }]}>
    <SessionMarkdown content="![参考](file:///reference/ui.png)" />
  </TranscriptSessionProvider>);
  await screen.findByRole("img");
  expect(readMedia).toHaveBeenCalledWith("s", "ui.png", "ref");
});

function Preview({ content }: { content: string }) {
  const images = useWorkspaceMarkdownImages({ sessionId: "s", path: "docs/guide.md", rootId: "ref" });
  return <MarkdownRenderer content={content} {...images} />;
}

it("resolves encoded paths relative to the Markdown document", async () => {
  render(<Preview content="![截图](../images/my%20screen.png)" />);
  await screen.findByRole("img");
  expect(readMedia).toHaveBeenCalledWith("s", "images/my screen.png", "ref");
});

it("keeps external images external", () => {
  render(<Preview content="![外部](https://example.com/a.png)" />);
  expect(screen.getByRole("img")).toHaveAttribute("src", "https://example.com/a.png");
  expect(readMedia).not.toHaveBeenCalled();
});

it("shows a read error and recovers when the image source changes", async () => {
  readMedia.mockRejectedValueOnce(new Error("missing"));
  const { rerender } = render(<Preview content="![截图](missing.png)" />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("图片加载失败：截图"));
  expect(screen.queryByRole("img")).toBeNull();
  rerender(<Preview content="![截图](available.png)" />);
  expect(await screen.findByRole("img")).toHaveAttribute("src", "blob:test/image");
});

it("does not expose stale image results after navigation", async () => {
  let complete!: (blob: Blob) => void;
  readMedia.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  const { rerender } = render(<Preview content="![旧图](old.png)" />);
  rerender(<Preview content="![新图](new.png)" />);
  await screen.findByRole("img", { name: "新图" });
  complete(new Blob(["old"]));
  await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
});

describe("image path boundaries", () => {
  it.each(["../../outside.png", "javascript:alert(1)", "/outside/image.png"])("rejects %s", (src) => {
    expect(resolveMarkdownImage(src, { sessionId: "s", path: "docs/guide.md", workspacePath: "/repo" })).toBeNull();
  });
});
