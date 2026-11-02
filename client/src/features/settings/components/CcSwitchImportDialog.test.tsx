import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CcSwitchPreviewResponse } from "../../../shared/contracts/config";
import { CcSwitchImportDialog } from "./CcSwitchImportDialog";

const { messages, previewMock, importMock } = vi.hoisted(() => ({
  messages: {
    llmImportTitle: "从 CC Switch 导入",
    llmImportLoading: "正在读取 CC Switch 配置…",
    llmImportUnavailable: "未检测到 CC Switch 配置库",
    llmImportEmpty: "没有可导入的供应商",
    llmImportSelectAll: "全选",
    llmImportConflictNone: "新增",
    llmImportConflictDuplicate: "已导入",
    llmImportConflictEndpoint: "同端点",
    llmImportModels: "{count} 个模型",
    llmImportValidate: "导入前校验连接",
    llmImportSubmit: "导入 {count} 个",
    llmImportConsequence: "所选供应商的 API Key 将复制到本机 Synax 配置",
    llmImportResult: "已导入 {imported} 个，跳过 {skipped} 个",
    llmImportFailed: "导入失败",
    llmImportClose: "关闭",
    llmImportCancel: "取消",
  } as Record<string, string>,
  previewMock: vi.fn(),
  importMock: vi.fn(),
}));

vi.mock("../../../shared/hooks/useLocale", () => ({
  useLocale: () => ({
    locale: "zh",
    t: (key: string, vars?: Record<string, string | number>) => {
      const raw = messages[key] ?? key;
      if (!vars) return raw;
      return Object.entries(vars).reduce(
        (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
        raw,
      );
    },
  }),
}));

vi.mock("../../../adapters/transport/config", () => ({
  configApi: {
    previewCcSwitchProviders: previewMock,
    importCcSwitchProviders: importMock,
  },
}));

const preview: CcSwitchPreviewResponse = {
  available: true,
  sourcePath: "/Users/tester/.cc-switch/cc-switch.db",
  items: [
    {
      key: "claude:gateway",
      appType: "claude",
      label: "My Gateway",
      baseUrl: "https://gateway.example.test",
      apiFormat: "anthropic",
      apiKeyMasked: "sk-a****mnop",
      declaredModels: ["claude-sonnet-5", "deepseek-v4-flash"],
      defaultModel: "claude-sonnet-5",
      conflict: "none",
      selectable: true,
      warnings: [],
    },
    {
      key: "codex:rabbit",
      appType: "codex",
      label: "Rabbit",
      baseUrl: "https://rabbit.example.test/v1",
      apiFormat: "openai-responses",
      apiKeyMasked: "sk-b****mnop",
      declaredModels: ["gpt-6-sol"],
      defaultModel: "gpt-6-sol",
      conflict: "duplicate-id",
      conflictProviderId: "custom-api:ccsw-1234abcd",
      selectable: true,
      warnings: [],
    },
    {
      key: "claude:no-models",
      appType: "claude",
      label: "No models",
      baseUrl: "https://empty.example.test",
      apiFormat: "anthropic",
      apiKeyMasked: "sk-c****mnop",
      declaredModels: [],
      defaultModel: "",
      conflict: "none",
      selectable: false,
      reason: "没有可用模型",
      warnings: [],
    },
  ],
  unsupported: [],
  skipped: [],
  warnings: [],
};

function setup() {
  const onClose = vi.fn();
  const onImported = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <CcSwitchImportDialog open onClose={onClose} onImported={onImported} />,
  );
  return { ...view, onClose, onImported, user: userEvent.setup() };
}

beforeEach(() => {
  previewMock.mockReset().mockResolvedValue(preview);
  importMock.mockReset().mockResolvedValue({
    config: { providers: [], providerConnections: {} },
    imported: [{ providerId: "custom-api:ccsw-1", label: "My Gateway", action: "created" }],
    skipped: [{ providerId: "custom-api:ccsw-2", label: "Rabbit", action: "skipped", reason: "已导入过" }],
    warnings: ["Rabbit：探测失败（认证失败 (401)），已使用 CC Switch 里声明的模型"],
  });
});

describe("CcSwitchImportDialog", () => {
  it("lists candidates, preselects importable ones and imports the selection", async () => {
    const { user, onImported } = setup();

    expect(await screen.findByText("My Gateway")).toBeTruthy();
    expect(screen.getByText("https://rabbit.example.test/v1")).toBeTruthy();
    expect(screen.getByText(/2 个模型/)).toBeTruthy();
    // Conflict badges explain why an entry may look redundant.
    expect(screen.getByText("已导入")).toBeTruthy();
    expect(screen.getAllByText("新增").length).toBeGreaterThan(0);
    // A candidate without models stays visible but cannot be selected.
    const blocked = screen.getByRole("checkbox", { name: "No models (claude)" }) as HTMLInputElement;
    expect(blocked.disabled).toBe(true);
    expect(screen.getByText("没有可用模型")).toBeTruthy();

    const gateway = screen.getByRole("checkbox", { name: "My Gateway (claude)" }) as HTMLInputElement;
    const rabbit = screen.getByRole("checkbox", { name: "Rabbit (codex)" }) as HTMLInputElement;
    expect(gateway.checked).toBe(true);
    expect(rabbit.checked).toBe(true);

    await user.click(screen.getByRole("button", { name: "导入 2 个" }));

    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(1));
    expect(importMock).toHaveBeenCalledWith({
      keys: ["claude:gateway", "codex:rabbit"],
      validate: true,
    });
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("已导入 1 个，跳过 1 个")).toBeTruthy();
    expect(
      screen.getByText("Rabbit：探测失败（认证失败 (401)），已使用 CC Switch 里声明的模型"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
  });

  it("keeps the import disabled when nothing is selected", async () => {
    const { user } = setup();

    await screen.findByText("My Gateway");
    await user.click(screen.getByRole("checkbox", { name: "全选" }));

    const submit = screen.getByRole("button", { name: "导入 0 个" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(importMock).not.toHaveBeenCalled();
  });

  it("can skip the connection check", async () => {
    const { user } = setup();

    await screen.findByText("My Gateway");
    await user.click(screen.getByRole("checkbox", { name: "导入前校验连接" }));
    await user.click(screen.getByRole("button", { name: "导入 2 个" }));

    await waitFor(() =>
      expect(importMock).toHaveBeenCalledWith({
        keys: ["claude:gateway", "codex:rabbit"],
        validate: false,
      }),
    );
  });

  it("explains when CC Switch has no database", async () => {
    previewMock.mockResolvedValue({
      ...preview,
      available: false,
      items: [],
      warnings: ["未找到 CC Switch 数据库"],
    });
    setup();

    expect(await screen.findByText("未检测到 CC Switch 配置库")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /导入 \d+ 个/ })).toBeNull();
  });

  it("reports import failures without closing", async () => {
    importMock.mockRejectedValue(new Error("未找到 CC Switch 数据库"));
    const { user, onImported } = setup();

    await screen.findByText("My Gateway");
    await user.click(screen.getByRole("button", { name: "导入 2 个" }));

    expect(await screen.findByText("未找到 CC Switch 数据库")).toBeTruthy();
    expect(onImported).not.toHaveBeenCalled();
  });
});
