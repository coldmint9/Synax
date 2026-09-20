import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionMetrics } from "./ExtensionMetrics";
import { useProviderMetrics } from "./useProviderMetrics";
import {
  providerMetricsApi,
  type ProviderMetricField,
} from "../../../lib/api/providerMetrics";

vi.mock("../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "zh" }),
}));
vi.mock("../../../lib/api/providerMetrics", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../lib/api/providerMetrics")
  >()),
  providerMetricsApi: { list: vi.fn(), update: vi.fn(), discover: vi.fn() },
}));

const credit: ProviderMetricField = {
  id: "kiro-credit",
  providerId: "kiro",
  path: "usage.credit_usage",
  label: "Kiro credits",
  type: "number",
  unit: "credit",
  source: "declared",
  visible: false,
  accumulate: false,
  count: 2,
  lastValue: 0.125,
  total: 0.375,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(providerMetricsApi.list).mockResolvedValue({ fields: [] });
});

describe("ExtensionMetrics", () => {
  it("adds discovered fields dynamically and only offers accumulation for numbers", () => {
    const update = vi.fn().mockResolvedValue(undefined);
    render(
      <ExtensionMetrics
        fields={[
          credit,
          {
            ...credit,
            id: "tier",
            path: "usage.tier",
            label: "套餐",
            type: "string",
            source: "observed",
            unit: undefined,
            lastValue: "POWER",
          },
        ]}
        onUpdate={update}
      />,
    );
    expect(screen.queryByText("Kiro credits")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加参数" }));
    expect(screen.getByText("usage.credit_usage")).toBeInTheDocument();
    expect(screen.getByText("供应商声明")).toBeInTheDocument();
    expect(screen.getByText("自动发现")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "显示 Kiro credits" }),
    );
    expect(update).toHaveBeenCalledWith(credit, { visible: true });
    fireEvent.click(
      screen.getByRole("checkbox", { name: "累计 Kiro credits" }),
    );
    expect(update).toHaveBeenCalledWith(credit, { accumulate: true });
    expect(
      screen.queryByRole("checkbox", { name: "累计 套餐" }),
    ).not.toBeInTheDocument();
  });

  it("keeps missing values unknown while preserving small values, zero and booleans", () => {
    const { rerender } = render(
      <ExtensionMetrics
        fields={[
          {
            ...credit,
            visible: true,
            accumulate: true,
            lastValue: undefined,
            total: undefined,
            count: 0,
          },
        ]}
        onUpdate={vi.fn()}
        scope="session"
      />,
    );
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.getByText("本会话累计")).toBeInTheDocument();
    rerender(
      <ExtensionMetrics
        fields={[
          {
            ...credit,
            visible: true,
            accumulate: true,
            lastValue: 0.00000012,
            total: 0,
          },
          {
            ...credit,
            id: "flag",
            type: "boolean",
            label: "标记",
            visible: true,
            lastValue: false,
            unit: undefined,
          },
        ]}
        onUpdate={vi.fn()}
      />,
    );
    expect(screen.getByText("0.00000012")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("否")).toBeInTheDocument();
  });

  it("shows failures with existing data instead of silently clearing stored totals", () => {
    render(
      <ExtensionMetrics
        fields={[{ ...credit, visible: true, accumulate: true }]}
        error="Cannot connect"
        onUpdate={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Cannot connect");
    expect(screen.getByText("最近记录")).toBeInTheDocument();
    expect(screen.getByText("0.375")).toBeInTheDocument();
  });
});

describe("useProviderMetrics", () => {
  it("persists selection and reloads server totals after remount", async () => {
    let stored = credit;
    vi.mocked(providerMetricsApi.list).mockImplementation(async () => ({
      fields: [stored],
    }));
    vi.mocked(providerMetricsApi.update).mockImplementation(
      async (_id, patch) => {
        stored = { ...stored, ...patch };
        return { fields: [stored] };
      },
    );
    const first = renderHook(() =>
      useProviderMetrics({ sessionId: "session-a" }),
    );
    await waitFor(() => expect(first.result.current.fields).toHaveLength(1));
    await act(async () => {
      await first.result.current.update(credit, {
        visible: true,
        accumulate: true,
      });
    });
    await waitFor(() =>
      expect(first.result.current.fields[0].visible).toBe(true),
    );
    expect(providerMetricsApi.update).toHaveBeenCalledWith(
      "kiro-credit",
      { visible: true, accumulate: true },
      { providerId: undefined, sessionId: "session-a" },
    );
    first.unmount();
    const second = renderHook(() =>
      useProviderMetrics({ sessionId: "session-a" }),
    );
    await waitFor(() =>
      expect(second.result.current.fields[0]?.total).toBe(0.375),
    );
    expect(second.result.current.fields[0].accumulate).toBe(true);
  });

  it("ignores late responses from a previous session and does not mix provider changes", async () => {
    let finishOld!: (value: { fields: ProviderMetricField[] }) => void;
    vi.mocked(providerMetricsApi.list).mockImplementation(async (scope) => {
      if (scope.sessionId === "session-a")
        return new Promise((resolve) => {
          finishOld = resolve;
        });
      return {
        fields: [
          {
            ...credit,
            id: "provider-b-field",
            providerId: "provider-b",
            total: 8,
          },
        ],
      };
    });
    const { result, rerender } = renderHook(
      ({ sessionId }) => useProviderMetrics({ sessionId }),
      { initialProps: { sessionId: "session-a" } },
    );
    rerender({ sessionId: "session-b" });
    await waitFor(() => expect(result.current.fields[0]?.total).toBe(8));
    await act(async () => {
      finishOld({ fields: [credit] });
    });
    expect(result.current.fields).toHaveLength(1);
    expect(result.current.fields[0].providerId).toBe("provider-b");
    expect(result.current.fields[0].total).toBe(8);
  });
});
