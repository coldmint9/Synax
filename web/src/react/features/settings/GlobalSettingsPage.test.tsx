import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig, ProviderDef } from "../../../lib/contracts/config";
import { useState, type ReactNode } from "react";

// Appearance has its own integration tests using real HeroUI color controls.
vi.mock("./components/AppearanceSection", () => ({
  AppearanceSection: () => <div />,
}));

vi.mock("@heroui/react", () => {
  const Passthrough = ({ children, className }: any) => (
    <div className={className}>{children}</div>
  );
  const TabsComp = ({ children }: any) => <div>{children}</div>;
  TabsComp.ListContainer = Passthrough;
  TabsComp.List = ({ children }: any) => <div role="tablist">{children}</div>;
  TabsComp.Tab = ({ children, id }: any) => (
    <button role="tab" data-id={id}>
      {children}
    </button>
  );
  TabsComp.Indicator = () => null;
  TabsComp.Panel = ({ children }: any) => <div role="tabpanel">{children}</div>;
  const CardComp = ({ children, className }: any) => (
    <div className={className}>{children}</div>
  );
  CardComp.Header = Passthrough;
  CardComp.Content = Passthrough;
  CardComp.Footer = Passthrough;
  CardComp.Title = Passthrough;
  CardComp.Description = Passthrough;
  const SelectComp = ({ children, "aria-label": ariaLabel }: any) => (
    <div aria-label={ariaLabel}>{children}</div>
  );
  SelectComp.Trigger = Passthrough;
  SelectComp.Value = () => null;
  SelectComp.Indicator = () => null;
  SelectComp.Popover = Passthrough;
  const ListBoxComp = ({ children }: any) => (
    <div role="listbox">{children}</div>
  );
  ListBoxComp.Item = ({ children, id, textValue }: any) => (
    <div role="option" aria-label={textValue}>
      {children}
    </div>
  );
  ListBoxComp.ItemIndicator = () => null;
  const { createContext, useContext } = require("react");
  const fieldContext = createContext({
    value: "",
    onChange: (_value: string) => {},
  });
  const InputGroupComp = Object.assign(Passthrough, {
    Input: (props: any) => {
      const field = useContext(fieldContext);
      return (
        <input
          {...props}
          value={field.value ?? ""}
          onChange={(event) => field.onChange?.(event.target.value)}
        />
      );
    },
    Prefix: Passthrough,
    Suffix: Passthrough,
  });
  const dialog = (role: string) => ({
    Backdrop: ({ children, isOpen = true, isDismissable = true }: any) =>
      isOpen ? (
        <div data-dismissable={String(isDismissable)}>{children}</div>
      ) : null,
    Container: Passthrough,
    Dialog: ({ children }: any) => <div role={role}>{children}</div>,
    Header: Passthrough,
    Body: Passthrough,
    Footer: Passthrough,
    Heading: ({ children }: any) => <h2>{children}</h2>,
    Icon: () => null,
    CloseTrigger: () => null,
  });
  return {
    Modal: dialog("dialog"),
    AlertDialog: dialog("alertdialog"),
    TextField: ({ children, value, onChange }: any) => (
      <fieldContext.Provider value={{ value, onChange }}>
        <div>{children}</div>
      </fieldContext.Provider>
    ),
    InputGroup: InputGroupComp,
    FieldError: Passthrough,
    Description: Passthrough,
    Button: ({
      children,
      onPress,
      startContent,
      isLoading,
      isPending,
      isDisabled,
      isIconOnly,
      ...props
    }: any) => (
      <button
        onClick={onPress}
        disabled={isDisabled || isLoading || isPending}
        {...props}
      >
        {startContent}
        {typeof children === "function"
          ? children({ isPending: Boolean(isPending) })
          : children}
      </button>
    ),
    Card: CardComp,
    Chip: ({ children }: any) => <span>{children}</span>,
    Checkbox: Object.assign(
      ({ children, isSelected, onChange, isDisabled }: any) => (
        <label>
          <input
            type="checkbox"
            checked={isSelected}
            onChange={(e: any) => onChange?.(e.target.checked)}
            disabled={isDisabled}
          />
          {children}
        </label>
      ),
      {
        Control: Passthrough,
        Indicator: () => null,
        Content: Passthrough,
      },
    ),
    Input: ({
      value,
      onValueChange,
      placeholder,
      label,
      endContent,
      type,
      isDisabled,
      description,
      ...props
    }: any) => (
      <div>
        {label && <label>{label}</label>}
        <input
          value={value ?? ""}
          onChange={(e: any) => onValueChange?.(e.target.value)}
          placeholder={placeholder}
          type={type}
          disabled={isDisabled}
        />
        {endContent}
        {description && <span>{description}</span>}
      </div>
    ),
    Label: ({ children }: any) => <span>{children}</span>,
    ListBox: ListBoxComp,
    NumberField: Object.assign(
      ({ children, value, onChange, label }: any) => (
        <div>
          {label && <label>{label}</label>}
          {children}
          <input
            value={value ?? ""}
            onChange={(e: any) => onChange?.(Number(e.target.value) || 0)}
          />
        </div>
      ),
      {
        Group: Passthrough,
        Input: () => <span />,
      },
    ),
    ScrollShadow: Passthrough,
    Select: SelectComp,
    Spinner: ({ size }: any) => <span data-testid="spinner" data-size={size} />,
    Surface: Passthrough,
    Switch: Object.assign(
      ({ isSelected, onChange, children }: any) => (
        <label>
          <input
            type="checkbox"
            checked={isSelected}
            onChange={(e: any) => onChange?.(e.target.checked)}
          />
          {children}
        </label>
      ),
      {
        Control: Passthrough,
        Thumb: () => null,
        Content: Passthrough,
        Icon: () => null,
      },
    ),
    Tabs: TabsComp,
    TextArea: ({ value, onChange, label }: any) => (
      <div>
        {label && <label>{label}</label>}
        <textarea value={value} onChange={onChange} />
      </div>
    ),
    Typography: ({ children }: any) => <span>{children}</span>,
  };
});

const mocks = vi.hoisted(() => ({
  discoverAcp: vi.fn(),
  discoverAiModels: vi.fn(),
  validateAiApi: vi.fn(),
  reload: vi.fn(),
  updateGlobalConfig: vi.fn(),
  state: {
    loading: false,
    globalConfig: null as GlobalConfig | null,
    providers: [] as ProviderDef[],
  },
}));

const acpProviders: ProviderDef[] = [
  {
    id: "opencode-acp",
    label: "OpenCode ACP",
    status: "live",
    kind: "acp",
    caps: { canFollowUp: true, canCancel: true },
    models: [
      { id: "opencode-default", label: "OpenCode Default", isDefault: true },
    ],
  },
  {
    id: "cursor-acp",
    label: "Cursor ACP",
    status: "live",
    kind: "acp",
    caps: { canFollowUp: true, canCancel: true },
    models: [
      { id: "cursor-default", label: "Cursor Default", isDefault: true },
    ],
  },
];

function createGlobalConfig(extra?: Partial<GlobalConfig>): GlobalConfig {
  const providers: ProviderDef[] = [
    ...acpProviders,
    {
      id: "openai",
      label: "OpenAI",
      description: "OpenAI API",
      status: "live",
      kind: "api",
      caps: { canFollowUp: true, canCancel: true },
      models: [{ id: "gpt-4o-mini", label: "gpt-4o-mini", isDefault: true }],
    },
    {
      id: "anthropic",
      label: "Anthropic",
      description: "Anthropic Messages API",
      status: "live",
      kind: "api",
      caps: { canFollowUp: true, canCancel: true },
      models: [
        {
          id: "claude-3-5-sonnet-latest",
          label: "claude-3-5-sonnet-latest",
          isDefault: true,
        },
      ],
    },
    ...(extra?.providers?.filter(
      (p) =>
        !["opencode-acp", "cursor-acp", "openai", "anthropic"].includes(p.id),
    ) ?? []),
  ];

  const base: GlobalConfig = {
    version: 1,
    providers,
    defaultProviderId: "opencode-acp",
    defaultApiProviderId: "openai",
    enabledAcpProviderIds: ["opencode-acp"],
    providerConnections: {
      "opencode-acp": {
        providerId: "opencode-acp",
        baseUrl: "http://127.0.0.1:3210",
        extra: { kind: "acp" },
      },
      "cursor-acp": {
        providerId: "cursor-acp",
        baseUrl: "http://127.0.0.1:3210",
        extra: { kind: "acp" },
      },
      openai: {
        providerId: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKeyMasked: "sk-o****1234",
        extra: { kind: "api", apiFormat: "openai", model: "gpt-4o-mini" },
      },
      anthropic: {
        providerId: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        extra: {
          kind: "api",
          apiFormat: "anthropic",
          model: "claude-3-5-sonnet-latest",
        },
      },
      ...(extra?.providerConnections ?? {}),
    },
    limits: { maxAgentsPerProject: 10, agentTimeoutMs: 300000 },
    features: { allowProjectConnectionOverride: true },
    updatedAt: "2026-05-13T00:00:00.000Z",
    updatedBy: "test",
  };

  return {
    ...base,
    ...extra,
    providers,
    providerConnections: {
      ...base.providerConnections,
      ...(extra?.providerConnections ?? {}),
    },
    limits: { ...base.limits, ...(extra?.limits ?? {}) },
    features: { ...base.features, ...(extra?.features ?? {}) },
  };
}

// These tests exercise configuration and persistence, not per-keystroke logic.
// Paste is a real user input event and avoids re-rendering the full settings
// page for every character while the full suite runs in parallel.
async function pasteValue(
  user: ReturnType<typeof userEvent.setup>,
  field: HTMLElement,
  value: string,
) {
  await user.click(field);
  await user.paste(value);
}

async function renderPage() {
  const { default: GlobalSettingsPage } =
    await import("./GlobalSettingsPage.tsx");
  return render(
    <MemoryRouter>
      <GlobalSettingsPage />
    </MemoryRouter>,
  );
}

describe("GlobalSettingsPage LLM provider redesign", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    mocks.discoverAcp.mockResolvedValue({
      selectedProviderId: "opencode-acp",
      supported: [],
    });
    mocks.discoverAiModels.mockResolvedValue({
      ok: true,
      models: ["deepseek-chat"],
      source: "api/models",
    });
    mocks.validateAiApi.mockResolvedValue({ ok: true, message: "ok" });
    mocks.reload.mockResolvedValue(undefined);
    mocks.updateGlobalConfig.mockResolvedValue(undefined);
    mocks.state.globalConfig = createGlobalConfig();
    mocks.state.loading = false;
    mocks.state.providers = mocks.state.globalConfig.providers;

    const configModule = await import("../../../lib/api/config.ts");
    vi.spyOn(configModule.configApi, "getTerminalShell").mockResolvedValue({
      defaultPath: "/bin/zsh",
    });
    vi.spyOn(configModule.configApi, "listFileOpeners").mockResolvedValue({
      apps: [],
    });
    vi.spyOn(configModule.configApi, "discoverAcp").mockImplementation(
      mocks.discoverAcp,
    );
    vi.spyOn(configModule.configApi, "discoverAiModels").mockImplementation(
      mocks.discoverAiModels,
    );
    vi.spyOn(configModule.configApi, "validateAiApi").mockImplementation(
      mocks.validateAiApi,
    );

    const useConfigModule = await import("./useConfig.ts");
    vi.spyOn(useConfigModule, "useConfig").mockImplementation(() => ({
      globalConfig: mocks.state.globalConfig,
      projectConfig: null,
      effectiveConfig: null,
      providers: mocks.state.providers,
      llmProviders: mocks.state.providers,
      loading: mocks.state.loading,
      reload: mocks.reload,
      updateGlobalConfig: mocks.updateGlobalConfig,
      updateProjectConfig: vi.fn(),
      resetProjectConfig: vi.fn(),
    }));
  });

  it("does not expose ACP configuration in settings", async () => {
    await renderPage();
    expect(screen.queryByText("OpenCode ACP")).not.toBeInTheDocument();
    expect(screen.queryByText("Cursor ACP")).not.toBeInTheDocument();
    expect(mocks.discoverAcp).not.toHaveBeenCalled();
  });

  it("opens a blank custom-provider dialog directly without applying a preset", async () => {
    const user = userEvent.setup();
    await renderPage();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /添加/ }));
    const dialog = within(screen.getByRole("dialog"));
    expect(
      dialog.getByRole("heading", { name: "新增供应商" }),
    ).toBeInTheDocument();
    expect(dialog.getByPlaceholderText("My Provider")).toHaveValue(
      "Custom API 1",
    );
    expect(dialog.getByPlaceholderText("https://api.example.com")).toHaveValue(
      "",
    );
    expect(dialog.getByRole("textbox", { name: "模型" })).toHaveValue("");
    expect(dialog.getByPlaceholderText("输入 API Key")).toHaveValue("");
    expect(screen.queryByRole("button", { name: /^OpenAI$/ })).not.toBeInTheDocument();
    for (const protocol of [
      "OpenAI Chat Completions",
      "OpenAI Responses",
      "Anthropic Messages",
    ]) {
      expect(
        dialog.getByRole("option", { name: protocol }),
      ).toBeInTheDocument();
    }
    expect(mocks.validateAiApi).not.toHaveBeenCalled();
    expect(mocks.updateGlobalConfig).not.toHaveBeenCalled();
    await user.click(dialog.getByRole("button", { name: "关闭", exact: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.updateGlobalConfig).not.toHaveBeenCalled();
  });

  it("renders configured LLM provider cards with stored keys", async () => {
    mocks.state.globalConfig = createGlobalConfig({
      providerConnections: {
        openai: {
          providerId: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKeyMasked: "sk-o****1234",
          extra: { kind: "api", apiFormat: "openai", model: "gpt-4o-mini" },
        },
        anthropic: {
          providerId: "anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          apiKeyMasked: "sk-a****9999",
          extra: {
            kind: "api",
            apiFormat: "anthropic",
            model: "claude-3-5-sonnet-latest",
          },
        },
      },
    });
    mocks.state.providers = mocks.state.globalConfig.providers;

    await renderPage();

    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument();
    expect(screen.getByText("claude-3-5-sonnet-latest")).toBeInTheDocument();
  });

  it("automatically saves a custom model and keeps the dialog open for further edits", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole("button", { name: /添加/ }));

    expect(
      screen.getByRole("dialog").closest("[data-dismissable]"),
    ).toHaveAttribute("data-dismissable", "false");

    const baseUrlInput = screen.getByPlaceholderText("https://api.example.com");
    const modelInput = within(screen.getByRole("dialog")).getByRole("textbox", {
      name: "模型",
    });

    await user.clear(baseUrlInput);
    await pasteValue(user, baseUrlInput, "https://llm.internal/v1");
    expect(modelInput).toHaveValue("");
    await pasteValue(user, modelInput, "local-model");

    const apiKeyInput = screen.getByPlaceholderText("输入 API Key");
    await pasteValue(user, apiKeyInput, "sk-local");
    await waitFor(() => expect(mocks.validateAiApi).toHaveBeenCalled());
    await waitFor(() => expect(mocks.updateGlobalConfig).toHaveBeenCalled());

    const payload = mocks.updateGlobalConfig.mock.calls[0][0];
    const customProvider = payload.providers.find((p: ProviderDef) =>
      p.label.startsWith("Custom"),
    );
    expect(customProvider).toEqual(
      expect.objectContaining({
        kind: "api",
        models: [
          expect.objectContaining({ id: "local-model", isDefault: true }),
        ],
      }),
    );
    expect(payload.providerConnections[customProvider.id]).toEqual(
      expect.objectContaining({
        baseUrl: "https://llm.internal/v1",
        apiKey: "sk-local",
        extra: expect.objectContaining({ model: "local-model" }),
      }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.clear(modelInput);
    await pasteValue(user, modelInput, "another-model");
    await waitFor(() =>
      expect(mocks.updateGlobalConfig).toHaveBeenCalledTimes(2),
    );
    expect(
      mocks.updateGlobalConfig.mock.calls[1][0].providerConnections[
        customProvider.id
      ].extra.model,
    ).toBe("another-model");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭", exact: true }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("hides limits and advanced settings, and lets users retry opening the config", async () => {
    const user = userEvent.setup();
    const { configApi } = await import("../../../lib/api/config");
    const open = vi
      .spyOn(configApi, "openGlobalFile")
      .mockRejectedValueOnce(new Error("Editor could not start"))
      .mockResolvedValueOnce(undefined);
    await renderPage();
    expect(screen.queryByText("运行限制")).not.toBeInTheDocument();
    expect(screen.queryByText("高级")).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "打开配置文件" });
    await user.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Editor could not start",
    );
    await user.click(button);
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("discovers models as candidates and only configures the selected ones", async () => {
    const user = userEvent.setup();
    mocks.discoverAiModels.mockResolvedValueOnce({
      ok: true,
      models: ["gpt-4o-mini", "gpt-4.1", "gpt-4o"],
      source: "openai/models",
    });
    await renderPage();

    await user.click(screen.getByRole("button", { name: /添加/ }));
    // Add no longer offers presets: configure this provider through the real form.
    const dialog = within(screen.getByRole("dialog"));
    await user.clear(dialog.getByPlaceholderText("My Provider"));
    await pasteValue(
      user,
      dialog.getByPlaceholderText("My Provider"),
      "DeepSeek",
    );
    await pasteValue(
      user,
      dialog.getByPlaceholderText("https://api.example.com"),
      "https://api.deepseek.com",
    );
    await pasteValue(
      user,
      dialog.getByRole("textbox", { name: "模型" }),
      "deepseek-chat",
    );

    const apiKeyInput = screen.getByPlaceholderText("输入 API Key");
    await pasteValue(user, apiKeyInput, "sk-test");
    await user.click(screen.getByRole("button", { name: /发现/ }));

    // 发现的模型只是候选：没有任何一个被自动配置
    const discovered = await screen.findByRole("button", {
      name: "gpt-4.1",
      exact: true,
    });
    expect(discovered).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: "gpt-4o-mini", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");

    // 只勾选 gpt-4o，默认模型仍是 deepseek-chat
    await user.click(
      screen.getByRole("button", { name: "gpt-4o", exact: true }),
    );
    expect(
      screen.getByRole("button", { name: "gpt-4o", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "完成" }));
    // A prior autosave may contain only the default model. Wait for the
    // selected-model edit itself to persist, not merely for any save request.
    await waitFor(() => {
      expect(mocks.updateGlobalConfig).toHaveBeenCalled();
      const payload = mocks.updateGlobalConfig.mock.calls.at(-1)![0];
      const provider = payload.providers.find(
        (p: ProviderDef) =>
          p.label === "DeepSeek" && p.id.startsWith("custom-api:"),
      );
      expect(provider.models.map((m: { id: string }) => m.id)).toEqual([
        "deepseek-chat",
        "gpt-4o",
      ]);
      expect(
        provider.models.find((m: { id: string }) => m.id === "deepseek-chat"),
      ).toEqual(expect.objectContaining({ isDefault: true }));
      expect(payload.providerConnections[provider.id]).toMatchObject({
        baseUrl: "https://api.deepseek.com",
        apiKey: "sk-test",
        extra: { apiFormat: "openai", model: "deepseek-chat" },
      });
    });
    expect(mocks.discoverAiModels).toHaveBeenCalledExactlyOnceWith({
      providerId: undefined,
      format: "openai",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-test",
    });
  });

  it("configures the 1M input window per enabled model", async () => {
    const user = userEvent.setup();
    mocks.discoverAiModels.mockResolvedValueOnce({
      ok: true,
      models: ["deepseek-chat", "deepseek-reasoner"],
      source: "api/models",
    });
    await renderPage();

    await user.click(screen.getByRole("button", { name: /添加/ }));
    // Add no longer offers presets: configure this provider through the real form.
    const dialog = within(screen.getByRole("dialog"));
    await user.clear(dialog.getByPlaceholderText("My Provider"));
    await pasteValue(
      user,
      dialog.getByPlaceholderText("My Provider"),
      "DeepSeek",
    );
    await pasteValue(
      user,
      dialog.getByPlaceholderText("https://api.example.com"),
      "https://api.deepseek.com",
    );
    await pasteValue(
      user,
      dialog.getByRole("textbox", { name: "模型" }),
      "deepseek-chat",
    );

    await pasteValue(
      user,
      screen.getByPlaceholderText("输入 API Key"),
      "sk-test",
    );
    await user.click(screen.getByRole("button", { name: /发现/ }));
    await user.click(
      await screen.findByRole("button", {
        name: "deepseek-reasoner",
        exact: true,
      }),
    );
    await user.click(screen.getByRole("button", { name: "完成" }));

    const chatWindow = screen.getByRole("checkbox", {
      name: "deepseek-chat 输入上下文窗口支持 1M",
    });
    const reasonerWindow = screen.getByRole("checkbox", {
      name: "deepseek-reasoner 输入上下文窗口支持 1M",
    });
    expect(chatWindow).not.toBeChecked();

    // 逐个模型生效：只给 deepseek-reasoner 打开 1M
    await user.click(reasonerWindow);
    expect(reasonerWindow).toBeChecked();
    expect(chatWindow).not.toBeChecked();

    await waitFor(() => {
      expect(mocks.updateGlobalConfig).toHaveBeenCalled();
      const payload = mocks.updateGlobalConfig.mock.calls.at(-1)![0];
      const provider = payload.providers.find(
        (p: ProviderDef) =>
          p.label === "DeepSeek" && p.id.startsWith("custom-api:"),
      );
      expect(provider.models.map((m: { id: string }) => m.id)).toEqual([
        "deepseek-chat",
        "deepseek-reasoner",
      ]);
      expect(
        provider.models.find(
          (m: { id: string }) => m.id === "deepseek-reasoner",
        ),
      ).toEqual(expect.objectContaining({ contextLimit: 1_000_000 }));
      expect(
        provider.models.find((m: { id: string }) => m.id === "deepseek-chat")
          ?.contextLimit,
      ).toBeUndefined();
    });
  });

  it("preserves an incomplete draft during a visibility-triggered background reload", async () => {
    const user = userEvent.setup();
    const view = await renderPage();
    await user.click(screen.getByRole("button", { name: /添加/ }));
    await pasteValue(
      user,
      screen.getByPlaceholderText("https://api.example.com"),
      "https://unfinished.example",
    );
    fireEvent(document, new Event("visibilitychange"));
    expect(mocks.reload).toHaveBeenCalled();

    const { default: Page } = await import("./GlobalSettingsPage");
    mocks.state.loading = true;
    view.rerender(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("https://api.example.com")).toHaveValue(
      "https://unfinished.example",
    );
    mocks.state.loading = false;
    mocks.state.globalConfig = createGlobalConfig();
    view.rerender(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    );
    expect(screen.getByPlaceholderText("https://api.example.com")).toHaveValue(
      "https://unfinished.example",
    );
    expect(mocks.updateGlobalConfig).not.toHaveBeenCalled();
  });

  it("saves current provider edits immediately without closing the dialog", async () => {
    const user = userEvent.setup();
    await renderPage();
    const card = screen.getByText("OpenAI").closest(".settings-item")!;
    await user.click(within(card).getByRole("button", { name: /OpenAI/ }));
    await user.click(
      within(card).getByRole("button", { name: "编辑", exact: true }),
    );

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(screen.getByPlaceholderText("输入模型 ID"), {
      target: { value: "new-model" },
    });
    expect(mocks.updateGlobalConfig).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(dialog.getByRole("button", { name: "保存", exact: true }));
    });
    expect(mocks.updateGlobalConfig).toHaveBeenCalledTimes(1);
    expect(
      mocks.updateGlobalConfig.mock.calls[0][0].providerConnections.openai.extra.model,
    ).toBe("new-model");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("sets a selected model as default from its capability card", async () => {
    const user = userEvent.setup();
    const openaiProvider = mocks.state.globalConfig!.providers.find(
      (p) => p.id === "openai",
    )!;
    openaiProvider.models.push({ id: "gpt-4o", label: "gpt-4o" });
    await renderPage();
    const card = screen.getByText("OpenAI").closest(".settings-item")!;
    await user.click(within(card).getByRole("button", { name: /OpenAI/ }));
    await user.click(
      within(card).getByRole("button", { name: "编辑", exact: true }),
    );

    const dialog = within(screen.getByRole("dialog"));
    const alternative = dialog.getByRole("group", { name: "gpt-4o 独立能力" });
    const setDefault = within(alternative).getByRole("button", {
      name: "将 gpt-4o 设为默认",
    });
    expect(setDefault).toHaveClass(
      "group-hover:opacity-100",
      "focus-visible:opacity-100",
    );
    expect(within(alternative).queryByText("默认")).not.toBeInTheDocument();
    await user.click(setDefault);
    expect(within(alternative).getByText("默认")).toBeInTheDocument();
    expect(dialog.getByRole("textbox", { name: "模型" })).toHaveValue("gpt-4o");
    await waitFor(() => {
      expect(
        mocks.updateGlobalConfig.mock.calls.at(-1)?.[0].providerConnections.openai.extra.model,
      ).toBe("gpt-4o");
    });
  });

  it("flushes edits on explicit close and preserves the dialog on save failure for retry", async () => {
    const user = userEvent.setup();
    await renderPage();
    // Edit the configured provider (with its stored key), rather than a removed preset.
    const card = screen.getByText("OpenAI").closest(".settings-item")!;
    await user.click(within(card).getByRole("button", { name: /OpenAI/ }));
    await user.click(
      within(card).getByRole("button", { name: "编辑", exact: true }),
    );
    expect(
      within(screen.getByRole("dialog")).getByRole("heading", {
        name: "OpenAI 配置",
      }),
    ).toBeInTheDocument();
    const input = screen.getByPlaceholderText("输入模型 ID");
    // Control only this debounce race: Close, not an elapsed timer, must
    // trigger the first save. Native click events still exercise the real handler.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mocks.updateGlobalConfig.mockRejectedValueOnce(new Error("写入失败"));
    fireEvent.change(input, { target: { value: "changed-model" } });
    expect(mocks.updateGlobalConfig).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "关闭", exact: true }),
      );
    });
    expect(
      screen.getByText("写入失败", { selector: "div" }),
    ).toBeInTheDocument();
    expect(input).toHaveValue("changed-model");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    });
    expect(
      within(screen.getByRole("dialog")).getByRole("status"),
    ).toHaveTextContent("已保存");
    expect(mocks.updateGlobalConfig).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const payload = mocks.updateGlobalConfig.mock.calls[1][0];
    expect(payload.providerConnections.openai.extra.model).toBe(
      "changed-model",
    );
    expect(payload.providerConnections.openai.apiKey).toBeUndefined();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "关闭", exact: true }),
      );
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.updateGlobalConfig).toHaveBeenCalledTimes(2);
  });

  it("removes a configured provider card", async () => {
    const user = userEvent.setup();
    const deepseekProvider: ProviderDef = {
      id: "custom-api:deepseek",
      label: "DeepSeek",
      description: "DeepSeek OpenAI-compatible API",
      status: "live",
      kind: "api",
      caps: { canFollowUp: true, canCancel: true },
      models: [
        { id: "deepseek-chat", label: "deepseek-chat", isDefault: true },
      ],
    };
    mocks.state.globalConfig = createGlobalConfig({
      providers: [...acpProviders, deepseekProvider],
      providerConnections: {
        "custom-api:deepseek": {
          providerId: "custom-api:deepseek",
          baseUrl: "https://api.deepseek.com",
          apiKeyMasked: "sk-d****5678",
          extra: { kind: "api", apiFormat: "openai", model: "deepseek-chat" },
        },
      },
    });
    mocks.state.providers = mocks.state.globalConfig.providers;
    await renderPage();

    expect(screen.getByText("DeepSeek")).toBeInTheDocument();
    fireEvent.click(screen.getByText("DeepSeek").closest("button")!);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /删除/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /删除/ }));
    expect(mocks.updateGlobalConfig).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "删除",
        exact: true,
      }),
    );

    expect(mocks.updateGlobalConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.not.arrayContaining([
          expect.objectContaining({ id: "custom-api:deepseek" }),
        ]),
      }),
    );
  });

  it("sets a configured provider as default", async () => {
    const user = userEvent.setup();
    const deepseekProvider: ProviderDef = {
      id: "custom-api:deepseek",
      label: "DeepSeek",
      description: "DeepSeek OpenAI-compatible API",
      status: "live",
      kind: "api",
      caps: { canFollowUp: true, canCancel: true },
      models: [
        { id: "deepseek-chat", label: "deepseek-chat", isDefault: true },
      ],
    };
    mocks.state.globalConfig = createGlobalConfig({
      providers: [...acpProviders, deepseekProvider],
      providerConnections: {
        "custom-api:deepseek": {
          providerId: "custom-api:deepseek",
          baseUrl: "https://api.deepseek.com",
          apiKeyMasked: "sk-d****5678",
          extra: { kind: "api", apiFormat: "openai", model: "deepseek-chat" },
        },
      },
    });
    mocks.state.providers = mocks.state.globalConfig.providers;
    await renderPage();

    fireEvent.click(screen.getByText("DeepSeek").closest("button")!);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /设为默认/ }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /设为默认/ }));

    expect(mocks.updateGlobalConfig).toHaveBeenCalledWith({
      defaultApiProviderId: "custom-api:deepseek",
    });
  });
});
