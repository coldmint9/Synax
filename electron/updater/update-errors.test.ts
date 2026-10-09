import { expect, it } from "vitest";
import { updateFailureMessage } from "./update-errors.js";

it.each([
  ["ENOSPC", "磁盘空间不足"],
  ["EACCES", "权限"],
  ["ERR_UPDATER_INVALID_SIGNATURE", "签名验证"],
  ["sha512 checksum mismatch", "校验失败"],
  ["ERR_UPDATER_CHANNEL_FILE_NOT_FOUND", "清单尚未就绪"],
  ["HttpError: 403", "拒绝访问"],
  ["net::ERR_CONNECTION_RESET", "网络"],
  ["ETIMEDOUT", "网络"],
])("maps %s to actionable guidance", (message, expected) => {
  expect(updateFailureMessage(new Error(message))).toContain(expected);
});
it("does not expose framework stacks, headers or request secrets", () => {
  const result = updateFailureMessage(new Error('HttpError: 404 https://proxy.example/?token=secret\nHeaders: Authorization: secret\nat request()'));
  expect(result).toContain("清单");
  expect(result).not.toMatch(/secret|Headers|at request|https:/);
});
it("handles unknown and non-Error failures", () => {
  for (const value of [null, undefined, {}, new Error("Cannot read properties of undefined")])
    expect(updateFailureMessage(value)).toContain("详细原因已记录");
});
it("retains concise application guidance", () => {
  expect(updateFailureMessage(new Error("请先将 Synax 拖入应用程序文件夹。")))
    .toBe("请先将 Synax 拖入应用程序文件夹。");
});
