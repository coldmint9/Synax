import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LlmProviderModal } from "./LlmProviderModal";
import {
  createCustomDraft,
  type ApiProviderDraft,
} from "../lib/providerPresets";

vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "zh", t: (key: string) => key }),
}));

function setup(overrides: Partial<ApiProviderDraft> = {}, isNew = true) {
  const draft = {
    ...createCustomDraft([]),
    baseUrl: "https://api.example.com/v1",
    apiKey: "demo-key",
    ...overrides,
  };
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const onDiscoverModels = vi.fn().mockResolvedValue(["model-a", "model-b"]);
  const onValidate = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <LlmProviderModal
      draft={draft}
      isNew={isNew}
      onSave={onSave}
      onClose={onClose}
      onDiscoverModels={onDiscoverModels}
      onValidate={onValidate}
    />,
  );
  return {
    ...view,
    draft,
    onSave,
    onClose,
    onDiscoverModels,
    onValidate,
    user: userEvent.setup(),
  };
}

async function models(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "连接并获取模型" }));
  await screen.findByRole("checkbox", { name: "model-a" });
}

describe("provider setup", () => {
  it("reassigns the default when deselected and prevents saving an empty selection", async () => {
    const { user, onSave } = setup();
    await models(user);
    await user.click(screen.getByRole("checkbox", { name: "model-a" }));
    await user.click(screen.getByRole("checkbox", { name: "model-b" }));
    await user.click(screen.getByRole("checkbox", { name: "model-a" }));
    expect(
      screen.getByRole("button", { name: "model-b 设为默认" }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("checkbox", { name: "model-b" }));
    expect(screen.getByRole("button", { name: "添加供应商" })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps model capability overrides independent", async () => {
    const { user, onSave } = setup({
      model: "model-a",
      models: ["model-a", "model-b"],
    });
    await models(user);
    await user.click(screen.getByRole("button", { name: "高级模型设置" }));
    await user.click(
      within(screen.getByRole("group", { name: "输入能力" })).getByRole("checkbox", { name: "图片" }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: "输入上下文窗口支持 1M" }),
    );
    await user.click(screen.getByRole("button", { name: "添加供应商" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].modelMeta["model-a"]).toMatchObject({
      inputModalities: ["image"],
      contextLimit: 1_000_000,
    });
    expect(onSave.mock.calls[0][0].modelMeta["model-b"]).toBeUndefined();
  });
  it("does not persist a new provider before confirmation, even after discovery and selection", async () => {
    const { user, onSave, onClose } = setup();
    expect(screen.queryByText("供应商名称")).not.toBeInTheDocument();
    await models(user);
    expect(screen.getByRole("searchbox", { name: "搜索模型" })).toHaveFocus();
    await user.click(screen.getByRole("checkbox", { name: "model-b" }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(onSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "添加供应商" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      model: "model-b",
      models: ["model-b"],
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cancels without saving and shows field errors only after an attempt", async () => {
    const { user, onSave, onClose, onDiscoverModels } = setup({
      apiKey: "",
      baseUrl: "",
    });
    expect(screen.queryByText("API Key 不能为空")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "连接并获取模型" }));
    expect(screen.getByText("API Key 不能为空")).toBeVisible();
    expect(onDiscoverModels).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("supports manual model entry after discovery fails and retries a failed save", async () => {
    const { user, onDiscoverModels, onSave, onClose } = setup();
    onDiscoverModels.mockRejectedValueOnce(new Error("No models endpoint"));
    onSave.mockRejectedValueOnce(new Error("Network unavailable"));
    await user.click(screen.getByRole("button", { name: "连接并获取模型" }));
    expect(await screen.findByText(/No models endpoint/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "手动添加模型" }));
    await user.type(
      screen.getByRole("textbox", { name: "模型 ID" }),
      "manual-model{Enter}",
    );
    await user.click(screen.getByRole("button", { name: "添加供应商" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Network unavailable",
    );
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "重试保存" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1][0].model).toBe("manual-model");
  });

  it("keeps editing autosave and the saved masked key", async () => {
    const { onSave, user } = setup(
      {
        apiKey: "",
        apiKeyMasked: "sk-****",
        model: "model-a",
        models: ["model-a"],
      },
      false,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "服务地址" }), {
      target: { value: "https://new.example.com/v1" },
    });
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].apiKeyMasked).toBe("sk-****");
    await user.click(screen.getByRole("button", { name: "管理模型" }));
    expect(screen.getByRole("checkbox", { name: "model-a" })).toBeChecked();
  });

  it("preserves default model when adding another manually and saves effort in canonical order", async () => {
    const { user, onSave } = setup({
      model: "model-a",
      models: ["model-a"],
      reasoningEfforts: ["high", "low", "medium", "high"],
    });
    await models(user);
    await user.click(screen.getByRole("button", { name: "手动添加模型" }));
    await user.type(
      screen.getByRole("textbox", { name: "模型 ID" }),
      "model-c{Enter}",
    );
    await user.click(screen.getByRole("button", { name: "添加供应商" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      model: "model-a",
      models: ["model-a", "model-c"],
      reasoningEfforts: ["low", "medium", "high"],
    });
  });
});
