import { describe, expect, it } from "vitest";
import { describeRunFailure, isTruncatedStreamFailure } from "../runFailure";

describe("isTruncatedStreamFailure", () => {
  it.each([
    "HttpError: Http client error: error decoding response body",
    "stream failed: incomplete message",
    "unexpected end of stream",
    "connection closed before message completed",
  ])("treats %s as a truncated reply stream", (reason) => {
    expect(isTruncatedStreamFailure(reason)).toBe(true);
  });

  it.each([
    "Invalid API key",
    "Context limit exceeded",
    "error sending request for url (https://api.example.com)",
    "",
    null,
    undefined,
  ])("does not treat %s as a truncated reply stream", (reason) => {
    expect(isTruncatedStreamFailure(reason)).toBe(false);
  });
});

describe("describeRunFailure", () => {
  it("replaces transport wording the user cannot act on", () => {
    const described = describeRunFailure(
      "HttpError: Http client error: error decoding response body",
      "zh",
    );
    expect(described).toBe("上游连接在输出过程中中断，已保留收到的内容；可以继续执行");
    expect(described).not.toMatch(/HttpError/);
    expect(describeRunFailure("error decoding response body", "en")).toMatch(
      /partial answer was kept/,
    );
  });

  it("keeps a reason the user can act on", () => {
    expect(describeRunFailure("Invalid API key", "zh")).toBe("Invalid API key");
  });

  it("has nothing to show without a reason", () => {
    expect(describeRunFailure(null, "zh")).toBeNull();
    expect(describeRunFailure("   ", "zh")).toBeNull();
  });
});
