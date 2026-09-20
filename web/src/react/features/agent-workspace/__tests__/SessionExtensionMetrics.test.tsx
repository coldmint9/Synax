import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionExtensionMetrics } from "../SessionExtensionMetrics";
import {
  providerMetricsApi,
  type ProviderMetricField,
} from "../../../../lib/api/providerMetrics";

vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "zh" }),
}));
vi.mock("../../../../lib/api/providerMetrics", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../lib/api/providerMetrics")
  >()),
  providerMetricsApi: { list: vi.fn(), update: vi.fn() },
}));

const field: ProviderMetricField = {
  id: "credits",
  providerId: "kiro",
  path: "usage.credit_usage",
  label: "Credits",
  type: "number",
  source: "declared",
  unit: "credit",
  visible: false,
  accumulate: false,
  count: 1,
  lastValue: 0.25,
  total: 0.25,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(providerMetricsApi.list).mockResolvedValue({ fields: [field] });
});

describe("SessionExtensionMetrics field selection", () => {
  it("retains an open selection across runtime completion and workspace remounts", async () => {
    const first = render(
      <SessionExtensionMetrics sessionId="one" isLive refreshKey="running" />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "添加参数" }));
    const checkbox = screen.getByRole("checkbox", { name: "显示 Credits" });
    first.rerender(
      <SessionExtensionMetrics
        sessionId="one"
        isLive={false}
        refreshKey="completed"
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "显示 Credits" })).toBe(
        checkbox,
      ),
    );
    first.unmount();
    render(
      <SessionExtensionMetrics
        sessionId="one"
        isLive={false}
        refreshKey="completed"
      />,
    );
    expect(
      await screen.findByRole("checkbox", { name: "显示 Credits" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "累计 Credits" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "收起参数选择" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("isolates picker state between sessions and retains an explicit close", async () => {
    const view = render(
      <SessionExtensionMetrics
        sessionId="one"
        isLive={false}
        refreshKey="completed"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "添加参数" }));
    view.rerender(
      <SessionExtensionMetrics
        sessionId="two"
        isLive={false}
        refreshKey="completed"
      />,
    );
    expect(
      await screen.findByRole("button", { name: "添加参数" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("checkbox", { name: "显示 Credits" }),
    ).not.toBeInTheDocument();
    view.rerender(
      <SessionExtensionMetrics
        sessionId="one"
        isLive={false}
        refreshKey="completed"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "收起参数选择" }),
    );
    view.unmount();
    render(
      <SessionExtensionMetrics
        sessionId="one"
        isLive={false}
        refreshKey="completed"
      />,
    );
    expect(
      await screen.findByRole("button", { name: "添加参数" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("checkbox", { name: "累计 Credits" }),
    ).not.toBeInTheDocument();
  });
});
