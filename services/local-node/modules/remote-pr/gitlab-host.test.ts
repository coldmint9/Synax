import { expect, it } from "vitest";
import { normalizeGitLabHost } from "./gitlab-host.js";

it.each([
  ["gitlab.com", "gitlab.com"],
  ["  GitLab.COM  ", "gitlab.com"],
  ["https://gitlab.com", "gitlab.com"],
  ["http://gitlab.com/", "gitlab.com"],
  ["https://gitlab.com/group/app/-/merge_requests?state=opened#top", "gitlab.com"],
  ["https://gitlab.com:443/", "gitlab.com"],
  ["http://gitlab.example.com:8080/group", "gitlab.example.com:8080"],
  ["gitlab.example.com/api/v4", "gitlab.example.com"],
])("keeps the bare host of %s", (input, expected) => {
  expect(normalizeGitLabHost(input)).toBe(expected);
});

it.each([
  "",
  "   ",
  "https://",
  "//gitlab.com",
  "git@gitlab.com:group/app.git",
  "user@gitlab.com",
  "gitlab.com:99999",
  ".gitlab.com",
  "gitlab.com.",
  "gitlab.com:",
  "git lab.com",
])("rejects unusable host %s", (input) => {
  expect(normalizeGitLabHost(input)).toBe("");
});
