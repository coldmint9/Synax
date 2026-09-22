import { useEffect, useState } from "react";
import { Button, InputGroup, Switch, TextField } from "@heroui/react";
import { ExternalLink, Search } from "lucide-react";
import type {
  GlobalConfig,
  UpdateGlobalConfigRequest,
  WebSearchAuthConfig,
  WebSearchConfig,
  WebSearchEngine,
} from "../../../../lib/contracts/config";
import { configApi } from "../../../../lib/api/config";
import { getApiOrigin } from "../../../../lib/api/origin";
import { useLocale } from "../../../../hooks/useLocale";
import { FormRow } from "./FormRow";
import { SaveIndicator } from "./SaveIndicator";
import { SettingsCard } from "./SettingsCard";
import { SettingsSelect } from "./SettingsSelect";

interface WebSearchSettingsProps {
  config: GlobalConfig;
  onUpdate: (patch: UpdateGlobalConfigRequest) => Promise<void>;
  onReload: () => Promise<void>;
}

const DEFAULT_WEB_SEARCH: WebSearchConfig = {
  routing: "auto",
  remote: { externalWebAccess: true, searchContextSize: "medium" },
  local: { engine: "duckduckgo", auth: { type: "none" } },
};

export function WebSearchSettings({
  config,
  onUpdate,
  onReload,
}: WebSearchSettingsProps) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [draft, setDraft] = useState(config.webSearch ?? DEFAULT_WEB_SEARCH);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authorizing, setAuthorizing] = useState(false);

  useEffect(
    () => setDraft(config.webSearch ?? DEFAULT_WEB_SEARCH),
    [config.webSearch],
  );
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.data?.type !== "synax:web-search-oauth") return;
      const apiOrigin = getApiOrigin() || window.location.origin;
      if (event.origin !== new URL(apiOrigin, window.location.href).origin)
        return;
      setAuthorizing(false);
      if (event.data.ok) void onReload();
      else setError(zh ? "OAuth 授权失败" : "OAuth authorization failed");
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [onReload, zh]);

  async function save(value = draft): Promise<boolean> {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await onUpdate({ webSearch: value });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function connectOAuth() {
    if (!(await save())) return;
    try {
      setAuthorizing(true);
      const { authorizationUrl } = await configApi.startWebSearchOAuth();
      const popup = window.open(
        authorizationUrl,
        "synax-web-search-oauth",
        "popup,width=620,height=760",
      );
      if (!popup)
        throw new Error(
          zh ? "浏览器阻止了授权窗口" : "The authorization popup was blocked",
        );
    } catch (cause) {
      setAuthorizing(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const updateLocal = (patch: Partial<WebSearchConfig["local"]>) =>
    setDraft((current) => ({
      ...current,
      local: { ...current.local, ...patch },
    }));
  const updateAuth = (patch: Partial<WebSearchAuthConfig>) =>
    updateLocal({ auth: { ...draft.local.auth, ...patch } });
  const localVisible = draft.routing === "auto" || draft.routing === "local";
  const remoteVisible = draft.routing === "auto" || draft.routing === "remote";
  const oauthConnected = Boolean(draft.local.auth.accessTokenMasked);

  return (
    <SettingsCard
      title={zh ? "网页搜索" : "Web Search"}
      description={
        zh
          ? "Responses 原生搜索优先；配置渠道不可用时最终降级到免授权公共引擎"
          : "Prefer native Responses search; use a public no-auth engine when configured channels are unavailable"
      }
      icon={Search}
      trailing={<SaveIndicator saving={saving} saved={saved} error={error} />}
    >
      <div className="settings-rows">
        <FormRow
          label={zh ? "路由策略" : "Routing"}
          description={
            zh
              ? "自动模式会探测 Responses web_search；端点不支持时记忆并降级"
              : "Auto probes Responses web_search, remembers unsupported endpoints, and falls back"
          }
        >
          <SettingsSelect
            aria-label={zh ? "网页搜索路由" : "Web search routing"}
            selectedKey={draft.routing}
            onSelectionChange={(key) =>
              key &&
              setDraft((current) => ({
                ...current,
                routing: key as WebSearchConfig["routing"],
              }))
            }
            options={[
              {
                key: "auto",
                label: zh ? "自动（推荐）" : "Auto (recommended)",
              },
              {
                key: "remote",
                label: zh ? "原生远程优先" : "Native remote first",
              },
              { key: "local", label: zh ? "仅本地引擎" : "Local engine only" },
              { key: "disabled", label: zh ? "禁用" : "Disabled" },
            ]}
          />
        </FormRow>

        {remoteVisible && (
          <>
            <FormRow
              label={zh ? "实时外网访问" : "Live external access"}
              description={
                zh
                  ? "关闭后让原生搜索使用缓存/索引结果"
                  : "Disable to use cached/indexed native results"
              }
            >
              <Switch
                size="sm"
                isSelected={draft.remote.externalWebAccess}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    remote: { ...current.remote, externalWebAccess: value },
                  }))
                }
              >
                <Switch.Content><Switch.Control>
                  <Switch.Thumb />
                </Switch.Control></Switch.Content>
              </Switch>
            </FormRow>
            <FormRow label={zh ? "远程搜索上下文" : "Remote search context"}>
              <SettingsSelect
                aria-label={zh ? "远程搜索上下文" : "Remote search context"}
                selectedKey={draft.remote.searchContextSize}
                onSelectionChange={(key) =>
                  key &&
                  setDraft((current) => ({
                    ...current,
                    remote: {
                      ...current.remote,
                      searchContextSize: key as "low" | "medium" | "high",
                    },
                  }))
                }
                options={[
                  { key: "low", label: zh ? "低" : "Low" },
                  { key: "medium", label: zh ? "中" : "Medium" },
                  { key: "high", label: zh ? "高" : "High" },
                ]}
              />
            </FormRow>
          </>
        )}

        {localVisible && (
          <>
            <FormRow label={zh ? "降级搜索引擎" : "Fallback search engine"}>
              <SettingsSelect
                aria-label={zh ? "搜索引擎" : "Search engine"}
                selectedKey={draft.local.engine}
                onSelectionChange={(key) => {
                  if (!key) return;
                  const engine = key as WebSearchEngine;
                  const type =
                    engine === "duckduckgo"
                      ? "none"
                      : engine === "custom"
                        ? draft.local.auth.type
                        : "api-key";
                  updateLocal({ engine, auth: { ...draft.local.auth, type } });
                }}
                options={[
                  { key: "duckduckgo", label: "DuckDuckGo" },
                  { key: "brave", label: "Brave Search API" },
                  { key: "tavily", label: "Tavily" },
                  {
                    key: "custom",
                    label: zh ? "自定义 JSON API" : "Custom JSON API",
                  },
                ]}
              />
            </FormRow>

            {draft.local.engine === "custom" && (
              <>
                <Field
                  label="Endpoint"
                  value={draft.local.endpoint ?? ""}
                  onChange={(endpoint) => updateLocal({ endpoint })}
                  placeholder="https://search.example.com/v1/search"
                />
                <FormRow label={zh ? "请求方法" : "HTTP method"}>
                  <SettingsSelect
                    aria-label={zh ? "请求方法" : "HTTP method"}
                    selectedKey={draft.local.method ?? "GET"}
                    onSelectionChange={(key) =>
                      key && updateLocal({ method: key as "GET" | "POST" })
                    }
                    options={[
                      { key: "GET", label: "GET" },
                      { key: "POST", label: "POST" },
                    ]}
                  />
                </FormRow>
                <Field
                  label={zh ? "查询参数名" : "Query parameter"}
                  value={draft.local.queryParam ?? ""}
                  onChange={(queryParam) =>
                    updateLocal({ queryParam: queryParam || undefined })
                  }
                  placeholder="q"
                />
                <Field
                  label={zh ? "结果数组路径" : "Result array path"}
                  value={draft.local.resultPath ?? ""}
                  onChange={(resultPath) => updateLocal({ resultPath })}
                  placeholder="results or web.results"
                />
                <Field
                  label={zh ? "标题字段" : "Title field"}
                  value={draft.local.titleField ?? ""}
                  onChange={(titleField) => updateLocal({ titleField })}
                  placeholder="title"
                />
                <Field
                  label={zh ? "链接字段" : "URL field"}
                  value={draft.local.urlField ?? ""}
                  onChange={(urlField) => updateLocal({ urlField })}
                  placeholder="url"
                />
                <Field
                  label={zh ? "摘要字段" : "Snippet field"}
                  value={draft.local.snippetField ?? ""}
                  onChange={(snippetField) => updateLocal({ snippetField })}
                  placeholder="snippet"
                />
              </>
            )}

            {draft.local.engine !== "duckduckgo" && (
              <FormRow label={zh ? "鉴权方式" : "Authentication"}>
                <SettingsSelect
                  aria-label={zh ? "鉴权方式" : "Authentication"}
                  selectedKey={draft.local.auth.type}
                  onSelectionChange={(key) =>
                    key &&
                    updateAuth({ type: key as WebSearchAuthConfig["type"] })
                  }
                  options={[
                    { key: "none", label: zh ? "无" : "None" },
                    { key: "api-key", label: "API key" },
                    { key: "bearer", label: "Bearer token" },
                    { key: "oauth2", label: "OAuth 2.0 + PKCE" },
                  ]}
                />
              </FormRow>
            )}

            {draft.local.auth.type === "api-key" && (
              <SecretField
                label="API key"
                value={draft.local.auth.apiKey ?? ""}
                placeholder={draft.local.auth.apiKeyMasked || "API key"}
                onChange={(apiKey) => updateAuth({ apiKey })}
              />
            )}
            {draft.local.auth.type === "bearer" && (
              <SecretField
                label="Bearer token"
                value={draft.local.auth.bearerToken ?? ""}
                placeholder={
                  draft.local.auth.bearerTokenMasked || "Bearer token"
                }
                onChange={(bearerToken) => updateAuth({ bearerToken })}
              />
            )}
            {["api-key", "bearer", "oauth2"].includes(
              draft.local.auth.type,
            ) && (
              <>
                <Field
                  label={zh ? "鉴权 Header（可选）" : "Auth header (optional)"}
                  value={draft.local.auth.headerName ?? ""}
                  onChange={(headerName) =>
                    updateAuth({ headerName: headerName || undefined })
                  }
                  placeholder="Authorization"
                />
                <Field
                  label={zh ? "令牌前缀（可选）" : "Token prefix (optional)"}
                  value={draft.local.auth.tokenPrefix ?? ""}
                  onChange={(tokenPrefix) => updateAuth({ tokenPrefix })}
                  placeholder="Bearer "
                />
              </>
            )}
            {draft.local.auth.type === "oauth2" && (
              <>
                <Field
                  label={zh ? "授权地址" : "Authorization URL"}
                  value={draft.local.auth.authorizationUrl ?? ""}
                  onChange={(authorizationUrl) =>
                    updateAuth({ authorizationUrl })
                  }
                  placeholder="https://provider.example.com/oauth/authorize"
                />
                <Field
                  label={zh ? "令牌地址" : "Token URL"}
                  value={draft.local.auth.tokenUrl ?? ""}
                  onChange={(tokenUrl) => updateAuth({ tokenUrl })}
                  placeholder="https://provider.example.com/oauth/token"
                />
                <Field
                  label="Client ID"
                  value={draft.local.auth.clientId ?? ""}
                  onChange={(clientId) => updateAuth({ clientId })}
                />
                <SecretField
                  label={
                    zh ? "Client secret（可选）" : "Client secret (optional)"
                  }
                  value={draft.local.auth.clientSecret ?? ""}
                  placeholder={
                    draft.local.auth.clientSecretMasked || "Client secret"
                  }
                  onChange={(clientSecret) => updateAuth({ clientSecret })}
                />
                <Field
                  label={
                    zh
                      ? "Scopes（空格或逗号分隔）"
                      : "Scopes (space or comma separated)"
                  }
                  value={(draft.local.auth.scopes ?? []).join(" ")}
                  onChange={(value) =>
                    updateAuth({
                      scopes: value.split(/[\s,]+/).filter(Boolean),
                    })
                  }
                />
                <FormRow
                  label={zh ? "OAuth 状态" : "OAuth status"}
                  description={
                    oauthConnected
                      ? zh
                        ? "已保存访问令牌；到期后自动刷新"
                        : "Access token saved; refreshes automatically"
                      : zh
                        ? "尚未连接"
                        : "Not connected"
                  }
                >
                  <Button
                    size="sm"
                    variant="secondary"
                    isDisabled={authorizing}
                    onPress={connectOAuth}
                  >
                    <ExternalLink size={13} />
                    {authorizing
                      ? zh
                        ? "授权中…"
                        : "Authorizing…"
                      : zh
                        ? "连接 OAuth"
                        : "Connect OAuth"}
                  </Button>
                </FormRow>
              </>
            )}
          </>
        )}

        <div className="settings-action-row flex justify-end">
          <Button
            size="sm"
            variant="primary"
            isDisabled={saving}
            onPress={() => void save()}
          >
            {zh ? "保存网页搜索设置" : "Save web search settings"}
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}

function Field({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <FormRow label={label}>
      <TextField value={value} onChange={onChange}>
        <InputGroup>
          <InputGroup.Input placeholder={placeholder} />
        </InputGroup>
      </TextField>
    </FormRow>
  );
}

function SecretField(props: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <FormRow label={props.label}>
      <TextField type="password" value={props.value} onChange={props.onChange}>
        <InputGroup>
          <InputGroup.Input placeholder={props.placeholder} />
        </InputGroup>
      </TextField>
    </FormRow>
  );
}
