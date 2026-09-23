import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  INPUT_OPTIMIZATION_TIMEOUT_MS,
  useInputOptimization,
} from "../useInputOptimization";
const mocks = vi.hoisted(() => ({ optimize: vi.fn() }));
vi.mock("../../../../../lib/api/inputOptimization", () => ({
  optimizeInput: mocks.optimize,
}));
vi.mock("../../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "zh" }),
}));
function setup() {
  return renderHook(
    ({ scope }) => {
      const [content, setContent] = useState("原始需求");
      return {
        content,
        setContent,
        ...useInputOptimization({
          scope,
          content,
          onContentChange: setContent,
          projectId: "p1",
          model: "p/current",
          backendId: "native",
        }),
      };
    },
    { initialProps: { scope: "s1" } },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
});

it("limits input optimization to 20 seconds", () => {
  expect(INPUT_OPTIMIZATION_TIMEOUT_MS).toBe(20_000);
});
it("fills the draft without submitting and supports a one-step undo", async () => {
  mocks.optimize.mockResolvedValue({ text: "优化的需求" });
  const { result } = setup();
  await act(async () => {
    await result.current.optimize();
  });
  expect(result.current.content).toBe("优化的需求");
  expect(result.current.canUndo).toBe(true);
  expect(mocks.optimize.mock.calls[0][0]).toEqual({
    projectId: "p1",
    text: "原始需求",
    model: "p/current",
    backendId: "native",
  });
  act(() => result.current.undo());
  expect(result.current.content).toBe("原始需求");
  expect(result.current.canUndo).toBe(false);
});
it("locks synchronously against repeated clicks", async () => {
  let resolve!: (value: { text: string }) => void;
  mocks.optimize.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const { result } = setup();
  act(() => {
    void result.current.optimize();
    void result.current.optimize();
  });
  expect(mocks.optimize).toHaveBeenCalledTimes(1);
  expect(result.current.pending).toBe(true);
  await act(async () => resolve({ text: "优化" }));
  expect(result.current.pending).toBe(false);
});
it("retains edits even when an aborted provider later returns", async () => {
  let resolve!: (value: { text: string }) => void;
  mocks.optimize.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const { result } = setup();
  act(() => {
    void result.current.optimize();
  });
  const signal = mocks.optimize.mock.calls[0][1];
  act(() => result.current.setContent("新内容"));
  expect(signal.aborted).toBe(true);
  await act(async () => resolve({ text: "过期结果" }));
  expect(result.current.content).toBe("新内容");
  expect(result.current.canUndo).toBe(false);
});
it("invalidates undo after manual edits", async () => {
  mocks.optimize.mockResolvedValue({ text: "优化" });
  const { result } = setup();
  await act(async () => {
    await result.current.optimize();
  });
  act(() => result.current.setContent("手动修改"));
  expect(result.current.canUndo).toBe(false);
  act(() => result.current.undo());
  expect(result.current.content).toBe("手动修改");
});
it("does not write a result into another scope", async () => {
  let resolve!: (value: { text: string }) => void;
  mocks.optimize.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const { result, rerender } = setup();
  act(() => {
    void result.current.optimize();
  });
  rerender({ scope: "s2" });
  await act(async () => resolve({ text: "旧会话结果" }));
  expect(result.current.content).toBe("原始需求");
  expect(result.current.pending).toBe(false);
});
it("aborts on unmount", () => {
  mocks.optimize.mockReturnValue(new Promise(() => {}));
  const { result, unmount } = setup();
  act(() => {
    void result.current.optimize();
  });
  const signal = mocks.optimize.mock.calls[0][1];
  unmount();
  expect(signal.aborted).toBe(true);
});
it("preserves the original and exposes an error when generation fails", async () => {
  mocks.optimize.mockRejectedValue(new Error("模型不可用"));
  const { result } = setup();
  await act(async () => {
    await result.current.optimize();
  });
  expect(result.current.content).toBe("原始需求");
  expect(result.current.error).toBe("模型不可用");
  expect(result.current.pending).toBe(false);
});
it("skips empty drafts", async () => {
  const { result } = setup();
  act(() => result.current.setContent("  "));
  await act(async () => {
    await result.current.optimize();
  });
  expect(mocks.optimize).not.toHaveBeenCalled();
});

it("a cancelled request cannot clear a newer request's lock or show its error", async () => {
  let rejectOld!: (reason: Error) => void;
  let resolveNew!: (value: { text: string }) => void;
  mocks.optimize
    .mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectOld = reject;
      }),
    )
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveNew = resolve;
      }),
    );
  const { result } = setup();
  act(() => {
    void result.current.optimize();
  });
  act(() => result.current.setContent("新需求"));
  act(() => {
    void result.current.optimize();
  });
  await act(async () => rejectOld(new Error("过期错误")));
  expect(result.current.pending).toBe(true);
  expect(result.current.error).toBeNull();
  act(() => {
    void result.current.optimize();
  });
  expect(mocks.optimize).toHaveBeenCalledTimes(2);
  await act(async () => resolveNew({ text: "新需求整理" }));
  expect(result.current.content).toBe("新需求整理");
  act(() => result.current.undo());
  expect(result.current.content).toBe("新需求");
});
