import { beforeEach, describe, expect, it, vi } from "vitest";
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../api/origin", () => ({ apiFetch: fetchMock }));
import { streamCommitMessage } from "../api/commitMessageStream";

function response(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
beforeEach(() => fetchMock.mockReset());
describe("commit message SSE client", () => {
  it("parses frames split across network chunks and requires final plus terminator", async () => {
    fetchMock.mockResolvedValue(
      response([
        'data: {"type":"delta","text":"fi',
        'x:"}\n\ndata: {"type":"final","message":"fix: done"}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const events: unknown[] = [];
    await streamCommitMessage(
      "s1",
      { rootId: "r1", model: "p/model" },
      (event) => events.push(event),
      new AbortController().signal,
    );
    expect(events).toEqual([
      { type: "delta", text: "fix:" },
      { type: "final", message: "fix: done" },
    ]);
    expect(fetchMock.mock.calls[0][0]).toContain(
      "/sessions/s1/git/commit-message/stream",
    );
  });
  it("handles CRLF frames split between chunks", async () => {
    fetchMock.mockResolvedValue(response([
      'data: {"type":"delta","text":"fix"}\r',
      '\n\r',
      '\ndata: {"type":"final","message":"fix"}\r\n\r\ndata: [DONE]\r\n\r\n',
    ]));
    const events: unknown[] = [];
    await streamCommitMessage("s1", { model: "p/m" }, event => events.push(event), new AbortController().signal);
    expect(events).toEqual([{ type: "delta", text: "fix" }, { type: "final", message: "fix" }]);
  });

  it("exposes an HTTP validation error before the stream opens", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Choose a model" }), { status: 400 }));
    await expect(streamCommitMessage("s1", { model: "" }, () => {}, new AbortController().signal)).rejects.toThrow("Choose a model");
  });

  it("rejects a server error and an incomplete stream", async () => {
    fetchMock.mockResolvedValueOnce(
      response([
        'data: {"type":"error","error":"model failed"}\n\ndata: [DONE]\n\n',
      ]),
    );
    await expect(
      streamCommitMessage(
        "s1",
        { model: "p/m" },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("model failed");
    fetchMock.mockResolvedValueOnce(
      response(['data: {"type":"delta","text":"partial"}\n\n']),
    );
    await expect(
      streamCommitMessage(
        "s1",
        { model: "p/m" },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(/incomplete/i);
  });
});
