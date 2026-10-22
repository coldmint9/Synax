import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerContextPicker } from "../ComposerContextPicker";
import { agentRuntimeApi } from "../../../adapters/transport/agentRuntime";
afterEach(() => vi.restoreAllMocks());
it("selects a custom subagent alongside existing references and exposes settings", async () => {
  vi.spyOn(agentRuntimeApi, "listReferenceOptions").mockResolvedValue({ items: [{ kind: "subagent", id: "review", label: "审查助手" }] });
  const onChange = vi.fn();
  render(<MemoryRouter><ComposerContextPicker projectId="p" backendId="native" references={[{ kind: "file", id: "README.md" }]}
    onChange={onChange} disabled={false} onOpen={() => {}} /></MemoryRouter>);
  await userEvent.click(screen.getByRole("button", { name: "添加上下文" }));
  await userEvent.click(screen.getByRole("button", { name: "自定义子代理" }));
  expect(await screen.findByRole("link", { name: "管理自定义子代理" })).toHaveAttribute("href", "/settings?section=subagents");
  await userEvent.click(await screen.findByRole("option", { name: /审查助手/ }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith([{ kind: "file", id: "README.md" }, { kind: "subagent", id: "review", label: "审查助手" }]));
  expect(agentRuntimeApi.listReferenceOptions).toHaveBeenCalledWith("p", "subagent", "", undefined);
});
