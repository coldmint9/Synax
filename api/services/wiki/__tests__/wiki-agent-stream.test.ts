import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  model: vi.fn<() => string | undefined>(),
  streamRun: vi.fn(async function* (..._args: unknown[]) {
    yield { type: "done", sessionId: "sess-1", runId: "run-1" };
  }),
}));
vi.mock("../wiki-model.js", () => ({ getWikiWorkflowModel: mocks.model }));

vi.mock("../../agent-runtime/runtime-stream-writer.js", () => ({
  recordRuntimeStream: (_id: string, source: unknown) => source,
}));

vi.mock("../../agent-runtime/loop-runtime.js", () => ({
  agentLoopRuntime: {
    streamRun: (...args: unknown[]) => mocks.streamRun(...args),
  },
}));

vi.mock("../wiki-loop-profile.js", () => ({
  ensureWikiProfileRegistered: vi.fn(),
}));

vi.mock("../wiki-plan-profile.js", () => ({
  ensurePlanProfileRegistered: vi.fn(),
}));

vi.mock("../wiki-refresh-profile.js", () => ({
  ensureRefreshProfileRegistered: vi.fn(),
}));

import { ensureWikiProfileRegistered } from "../wiki-loop-profile.js";
import { streamWikiAgent } from "../wiki-agent-stream.js";

describe("streamWikiAgent", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.model.mockReturnValue(undefined);
    mocks.streamRun.mockImplementation(async function* () {
      yield { type: "done", sessionId: "sess-1", runId: "run-1" };
    });
  });

  it("runs in-process inside wiki job child (not via parent IPC)", async () => {
    vi.stubEnv("SYNAX_WIKI_JOB_CHILD", "1");
    vi.stubEnv("SYNAX_AGENT_SESSION_IN_PROCESS", "0");

    const chunks = [];
    for await (const chunk of streamWikiAgent("sess-1", { locale: "zh" })) {
      chunks.push(chunk);
    }

    expect(ensureWikiProfileRegistered).toHaveBeenCalled();
    expect(mocks.streamRun).toHaveBeenCalledWith(
      "sess-1",
      { locale: "zh" },
      undefined,
      false,
    );
    expect(chunks).toHaveLength(1);
  });

  it("uses the configured Wiki model for worker generation and resume calls", async () => {
    vi.stubEnv("SYNAX_WIKI_JOB_CHILD", "1");
    mocks.model.mockReturnValue("openai/wiki-model");
    for await (const _ of streamWikiAgent(
      "sess-1",
      { locale: "zh" },
      undefined,
      true,
    )) {
    }
    expect(mocks.streamRun).toHaveBeenCalledWith(
      "sess-1",
      { locale: "zh", model: "openai/wiki-model" },
      undefined,
      true,
    );
  });

  it("applies newly saved settings to subsequent in-process calls and keeps explicit overrides", async () => {
    vi.stubEnv("SYNAX_WIKI_JOB_CHILD", "0");
    vi.stubEnv("SYNAX_AGENT_SESSION_IN_PROCESS", "1");
    mocks.model.mockReturnValue("openai/wiki-model");
    for await (const _ of streamWikiAgent("sess-1", { locale: "en" })) {
    }
    expect(mocks.streamRun).toHaveBeenLastCalledWith(
      "sess-1",
      { locale: "en", model: "openai/wiki-model" },
      undefined,
      false,
    );
    mocks.model.mockReturnValue("anthropic/new-wiki-model");
    for await (const _ of streamWikiAgent("sess-1", { locale: "en" })) {
    }
    expect(mocks.streamRun).toHaveBeenLastCalledWith(
      "sess-1",
      { locale: "en", model: "anthropic/new-wiki-model" },
      undefined,
      false,
    );
    for await (const _ of streamWikiAgent("sess-1", {
      model: "openai/explicit",
    })) {
    }
    expect(mocks.streamRun).toHaveBeenLastCalledWith(
      "sess-1",
      { model: "openai/explicit" },
      undefined,
      false,
    );
  });
});
