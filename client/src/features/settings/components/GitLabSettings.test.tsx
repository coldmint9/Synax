import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { GitLabSettings } from "./GitLabSettings";
import { configApi } from "../../../adapters/transport/config";
import type {
  GlobalConfig,
  GitLabConfig,
} from "../../../shared/contracts/config";
vi.mock("../../../adapters/transport/config", () => ({
  configApi: { validateGitLab: vi.fn() },
}));
const update = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(configApi.validateGitLab).mockImplementation(async ({ host }) => ({
    host,
    username: "mint",
    name: "Mint",
  }));
});
function Settings({ initial = { accounts: [] } }: { initial?: GitLabConfig }) {
  const [gitLab, setGitLab] = useState(initial);
  return (
    <GitLabSettings
      config={{ gitLab } as GlobalConfig}
      onUpdate={async (patch) => {
        update(patch);
        setGitLab({
          accounts: patch.gitLab!.accounts.map(({ token, ...account }) => ({
            ...account,
            ...(token ? { tokenMasked: "****" } : {}),
          })),
        });
      }}
    />
  );
}
it("verifies, saves, clears the token input, tests saved credentials and logs out", async () => {
  render(<Settings />);
  const token = screen.getByLabelText("个人访问令牌（Personal Access Token）");
  const save = screen.getByRole("button", { name: "验证并保存登录" });
  expect(save).toBeDisabled();
  await userEvent.type(token, "glpat-test-token");
  await userEvent.click(save);
  expect(configApi.validateGitLab).toHaveBeenCalledWith({
    host: "gitlab.com",
    token: "glpat-test-token",
  });
  expect(update).toHaveBeenCalledWith({
    gitLab: { accounts: [{ host: "gitlab.com", token: "glpat-test-token" }] },
  });
  await waitFor(() => expect(token).toHaveValue(""));
  expect(screen.getByRole("status")).toHaveTextContent("已登录 gitlab.com");
  await userEvent.click(screen.getByRole("button", { name: "检测连接" }));
  expect(configApi.validateGitLab).toHaveBeenLastCalledWith({
    host: "gitlab.com",
  });
  await userEvent.click(screen.getByRole("button", { name: "退出登录" }));
  expect(update).toHaveBeenLastCalledWith({ gitLab: { accounts: [] } });
  expect(screen.queryByRole("list", { name: 'GitLab 账号' })).toBeNull();
});
it("keeps a failed draft without saving and prevents duplicate submissions while checking", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(configApi.validateGitLab).mockReturnValue(
    new Promise((_resolve, r) => {
      reject = r;
    }),
  );
  render(<Settings />);
  const token = screen.getByLabelText("个人访问令牌（Personal Access Token）");
  await userEvent.type(token, "bad-token");
  await userEvent.click(screen.getByRole("button", { name: "验证并保存登录" }));
  expect(screen.getByRole("button", { name: "正在连接…" })).toBeDisabled();
  reject(new Error("登录已失效"));
  expect(await screen.findByRole("alert")).toHaveTextContent("登录已失效");
  expect(token).toHaveValue("bad-token");
  expect(update).not.toHaveBeenCalled();
});
it("preserves other hosts and never carries an unsaved token to a changed host", async () => {
  render(
    <Settings
      initial={{ accounts: [{ host: "work.test", tokenMasked: "****" }] }}
    />,
  );
  const host = screen.getByLabelText("GitLab 主机");
  const token = screen.getByLabelText("个人访问令牌（Personal Access Token）");
  await userEvent.type(token, "private");
  await userEvent.clear(host);
  await userEvent.type(host, "new.test");
  expect(token).toHaveValue("");
  await userEvent.type(token, "new-token");
  await userEvent.click(screen.getByRole("button", { name: "验证并保存登录" }));
  expect(update).toHaveBeenLastCalledWith({
    gitLab: {
      accounts: [
        { host: "work.test", tokenMasked: "****" },
        { host: "new.test", token: "new-token" },
      ],
    },
  });
  const list = screen.getByRole("list", { name: 'GitLab 账号' });
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
});
