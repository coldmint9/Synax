import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderMetricsSettings } from "./ProviderMetricsSettings";
import { providerMetricsApi } from "../../../../lib/api/providerMetrics";
import { createCustomDraft } from "../lib/providerPresets";

vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "zh" }),
}));
vi.mock("../../../../lib/api/providerMetrics", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../lib/api/providerMetrics")
  >()),
  providerMetricsApi: { list: vi.fn(), update: vi.fn(), discover: vi.fn() },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(providerMetricsApi.list).mockResolvedValue({ fields: [] });
  vi.mocked(providerMetricsApi.discover).mockResolvedValue({
    ok: true,
    supported: true,
    fields: [],
  });
});
afterEach(() => vi.useRealTimers());

describe("ProviderMetricsSettings", () => {
  it("discovers declarations automatically using saved credentials and refreshes after validation", async () => {
    const draft = {
      ...createCustomDraft([]),
      id: "kiro",
      baseUrl: "http://127.0.0.1:3000/claude-kiro-oauth/v1",
      apiKeyMasked: "****",
    };
    const { rerender } = render(<ProviderMetricsSettings draft={draft} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(providerMetricsApi.discover).toHaveBeenCalledWith(
      {
        providerId: "kiro",
        baseUrl: draft.baseUrl,
        apiKey: undefined,
        format: draft.format,
      },
      expect.any(AbortSignal),
    );
    expect(
      screen.getByText("自动读取供应商参数声明，不会为发现参数额外调用模型。"),
    ).toBeInTheDocument();
    rerender(<ProviderMetricsSettings draft={draft} revision={1} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(providerMetricsApi.discover).toHaveBeenCalledTimes(2);
  });

  it("debounces edits and explains unsupported discovery without reporting an error", async () => {
    vi.mocked(providerMetricsApi.discover).mockResolvedValue({
      ok: true,
      supported: false,
      fields: [],
    });
    const draft = {
      ...createCustomDraft([]),
      apiKey: "test-key",
      baseUrl: "https://old.example/v1",
    };
    const { rerender } = render(<ProviderMetricsSettings draft={draft} />);
    rerender(
      <ProviderMetricsSettings
        draft={{ ...draft, baseUrl: "https://new.example/v1" }}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(providerMetricsApi.discover).toHaveBeenCalledTimes(1);
    expect(providerMetricsApi.discover).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://new.example/v1" }),
      expect.any(AbortSignal),
    );
    expect(
      screen.getByText(
        "此供应商未声明参数；后续请求返回的扩展字段仍会自动发现。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
