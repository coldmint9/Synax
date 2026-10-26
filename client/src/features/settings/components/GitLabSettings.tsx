import { useRef, useState } from "react";
import {
  CheckCircle2,
  GitPullRequest,
  KeyRound,
  LogOut,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "../../../shared/ui/ui/Button";
import { Field, Input, Label, Description } from "../../../shared/ui/ui/Field";
import type {
  GlobalConfig,
  UpdateGlobalConfigRequest,
} from "../../../shared/contracts/config";
import { configApi } from "../../../adapters/transport/config";
import { useLocale } from "../../../shared/hooks/useLocale";
import "./gitlab-settings.css";

export function GitLabSettings({
  config,
  onUpdate,
}: {
  config: GlobalConfig;
  onUpdate: (patch: UpdateGlobalConfigRequest) => Promise<void>;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const accounts = config.gitLab?.accounts ?? [];
  const [host, setHost] = useState(() => accounts[0]?.host ?? "gitlab.com");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [verified, setVerified] = useState<Record<string, string>>({});
  const tokenInput = useRef<HTMLInputElement>(null);
  const hostInput = useRef<HTMLInputElement>(null);
  const normalizedHost = host.trim().toLowerCase();
  const existing = accounts.find((account) => account.host === normalizedHost);

  async function perform(operation: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function login() {
    const account = await configApi.validateGitLab({
      host: normalizedHost,
      ...(token.trim() ? { token: token.trim() } : {}),
    });
    await onUpdate({
      gitLab: {
        accounts: [
          ...accounts.filter((item) => item.host !== account.host),
          {
            host: account.host,
            ...(token.trim() ? { token: token.trim() } : {}),
          },
        ],
      },
    });
    setVerified((current) => ({
      ...current,
      [account.host]: account.username,
    }));
    setHost(account.host);
    setToken("");
    setNotice(
      zh
        ? `已登录 ${account.host} · @${account.username}`
        : `Signed in to ${account.host} as @${account.username}`,
    );
  }

  return (
    <div className="gitlab-settings">
      <header className="gitlab-settings__header">
        <div className="gitlab-settings__title">
          <GitPullRequest size={20} aria-hidden="true" />
          <h1>{zh ? "GitLab 登录" : "GitLab sign-in"}</h1>
          <span>{zh ? "内置连接" : "Built in"}</span>
        </div>
        <p>
          {zh
            ? "连接 GitLab，在对话中查看、创建和合并 MR。支持 GitLab.com 与自建实例。"
            : "Connect GitLab to view, create, and merge requests in your conversations. Supports self-managed instances."}
        </p>
      </header>
      {accounts.length > 0 && (
        <section aria-labelledby="gitlab-accounts-heading">
          <div className="gitlab-settings__section-heading">
            <h2 id="gitlab-accounts-heading">
              {zh ? "已保存的连接" : "Saved connections"}{" "}
              <span>{accounts.length}</span>
            </h2>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setHost("");
                setToken("");
                setError("");
                setNotice("");
                hostInput.current?.focus();
              }}
            >
              <Plus size={14} aria-hidden="true" />
              {zh ? "添加主机" : "Add host"}
            </Button>
          </div>
          <ul
            className="gitlab-settings__accounts"
            aria-label={zh ? "GitLab 账号" : "GitLab accounts"}
          >
            {accounts.map((account) => (
              <li key={account.host} className="gitlab-settings__account">
                <div className="gitlab-settings__account-info">
                  <span className="gitlab-settings__account-icon">
                    <GitPullRequest size={18} aria-hidden="true" />
                  </span>
                  <div className="min-w-0 text-sm">
                    <p className="font-medium break-words">{account.host}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {verified[account.host]
                        ? `@${verified[account.host]}`
                        : account.tokenMasked
                          ? zh
                            ? "已保存登录凭据"
                            : "Credentials saved"
                          : zh
                            ? "尚未登录"
                            : "Not signed in"}
                    </p>
                  </div>
                </div>
                <div className="gitlab-settings__account-actions">
                  <Button
                    size="sm"
                    disabled={busy || !account.tokenMasked}
                    onClick={() =>
                      void perform(async () => {
                        const user = await configApi.validateGitLab({
                          host: account.host,
                        });
                        setVerified((current) => ({
                          ...current,
                          [account.host]: user.username,
                        }));
                        setNotice(
                          zh
                            ? `${account.host} 连接正常 · @${user.username}`
                            : `${account.host} connected as @${user.username}`,
                        );
                      })
                    }
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    {zh ? "检测连接" : "Test connection"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setHost(account.host);
                      setToken("");
                      setError("");
                      setNotice("");
                      tokenInput.current?.focus();
                    }}
                  >
                    {zh ? "更新令牌" : "Replace token"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await onUpdate({
                          gitLab: {
                            accounts: accounts.filter(
                              (item) => item.host !== account.host,
                            ),
                          },
                        });
                        setVerified((current) => {
                          const next = { ...current };
                          delete next[account.host];
                          return next;
                        });
                        if (normalizedHost === account.host) setToken("");
                        setNotice(
                          zh
                            ? `已移除 ${account.host} 的本机登录凭据。`
                            : `Removed local credentials for ${account.host}.`,
                        );
                      })
                    }
                  >
                    <LogOut size={13} aria-hidden="true" />
                    {zh ? "退出登录" : "Sign out"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && (
        <p
          role="alert"
          data-error-toast="off"
          className="gitlab-settings__feedback gitlab-settings__feedback--error"
        >
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="gitlab-settings__feedback">
          <CheckCircle2 size={16} aria-hidden="true" />
          {notice}
        </p>
      )}
      <div className="gitlab-settings__columns">
        <form
          className="gitlab-settings__form"
          onSubmit={(event) => {
            event.preventDefault();
            void perform(login);
          }}
        >
          <div className="gitlab-settings__form-heading">
            <KeyRound size={16} aria-hidden="true" />
            <h2>
              {existing?.tokenMasked
                ? zh
                  ? "更新登录配置"
                  : "Update sign-in"
                : zh
                  ? "添加 GitLab 连接"
                  : "Add a GitLab connection"}
            </h2>
          </div>
          <Field disabled={busy}>
            <Label>{zh ? "GitLab 主机" : "GitLab host"}</Label>
            <Input
              ref={hostInput}
              value={host}
              onChange={(event) => {
                setHost(event.target.value);
                setToken("");
                setError("");
                setNotice("");
              }}
              required
              autoCapitalize="none"
              spellCheck={false}
              placeholder="gitlab.com"
            />
            <Description>
              {zh
                ? "填写域名即可；自建实例可附加端口。"
                : "Enter a hostname, with an optional port for self-managed instances."}
            </Description>
          </Field>
          <Field disabled={busy}>
            <Label>
              {zh
                ? "个人访问令牌（Personal Access Token）"
                : "Personal Access Token"}
            </Label>
            <Input
              ref={tokenInput}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={
                existing?.tokenMasked
                  ? zh
                    ? "已保存；留空使用现有令牌"
                    : "Saved; leave blank to use the current token"
                  : "glpat-…"
              }
              required={!existing?.tokenMasked}
            />
            <Description>
              {zh
                ? "需要 api 权限。已保存的令牌不会回显，留空可继续使用。"
                : "The api scope is required. Saved tokens stay hidden; leave blank to keep the current token."}
            </Description>
          </Field>
          <div className="gitlab-settings__form-footer">
            <Button
              type="submit"
              variant="primary"
              size="lg"
              pending={busy}
              disabled={
                !normalizedHost || (!token.trim() && !existing?.tokenMasked)
              }
            >
              {busy
                ? zh
                  ? "正在连接…"
                  : "Connecting…"
                : zh
                  ? "验证并保存登录"
                  : "Verify and save"}
            </Button>
            <span>
              <ShieldCheck size={14} aria-hidden="true" />
              {zh ? "令牌加密保存在本机" : "Encrypted on this device"}
            </span>
          </div>
        </form>
        <aside
          className="gitlab-settings__guide"
          aria-labelledby="gitlab-guide-heading"
        >
          <h2 id="gitlab-guide-heading">
            {zh ? "连接只需三步" : "Get connected in three steps"}
          </h2>
          <ol>
            <li>
              <strong>
                {zh ? "创建个人访问令牌" : "Create an access token"}
              </strong>
              <p>
                {zh
                  ? "在 GitLab 的用户设置中创建 Personal Access Token。"
                  : "Create a Personal Access Token in your GitLab user settings."}
              </p>
            </li>
            <li>
              <strong>{zh ? "选择 api 权限" : "Choose the api scope"}</strong>
              <p>
                {zh
                    ? "复制令牌，粘贴到表单并验证登录。"
                  : "Copy the token, paste it into the form, and verify your sign-in."}
              </p>
            </li>
            <li>
              <strong>
                {zh ? "回到对话管理 MR" : "Manage MRs in a conversation"}
              </strong>
              <p>
                {zh
                  ? "打开 PR 面板，选择 GitLab 远程仓库。"
                  : "Open the PR panel and select your GitLab remote."}
              </p>
            </li>
          </ol>
          <details>
            <summary>
              {zh ? "连接与退出说明" : "Connection and sign-out details"}
            </summary>
            <p>
              {zh
                ? "连接使用 HTTPS。Git 推送和拉取仍使用仓库已有的 SSH 或 HTTPS 凭据。退出仅移除 Synax 中的登录凭据；如需撤销令牌，请前往 GitLab。"
                : "Connections use HTTPS. Git push and fetch use your existing SSH or HTTPS credentials. Signing out removes Synax credentials; revoke the token in GitLab if needed."}
            </p>
          </details>
        </aside>
      </div>
    </div>
  );
}
