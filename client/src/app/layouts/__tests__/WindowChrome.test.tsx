import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowChrome } from "../WindowChrome";

type ElectronWindowApi = {
  platform: string;
  minimizeWindow: ReturnType<typeof vi.fn>;
  toggleMaximizeWindow: ReturnType<typeof vi.fn>;
  closeWindow: ReturnType<typeof vi.fn>;
  getWindowState: ReturnType<typeof vi.fn>;
  onWindowStateChanged: ReturnType<typeof vi.fn>;
};

const originalElectronApi = (window as Window & { electronAPI?: unknown }).electronAPI;

afterEach(() => {
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: originalElectronApi,
  });
});

function setElectronApi(platform: string): ElectronWindowApi {
  const api: ElectronWindowApi = {
    platform,
    minimizeWindow: vi.fn(async () => true),
    toggleMaximizeWindow: vi.fn(async () => true),
    closeWindow: vi.fn(async () => true),
    getWindowState: vi.fn(async () => ({ maximized: false })),
    onWindowStateChanged: vi.fn(() => () => {}),
  };
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: api,
  });
  return api;
}

describe("WindowChrome", () => {
  it("renders the custom controls on Windows", async () => {
    const api = setElectronApi("win32");
    render(<WindowChrome />);

    expect(await screen.findByRole("toolbar", { name: "Window controls" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Minimize window" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize window" }));
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));

    expect(api.minimizeWindow).toHaveBeenCalledOnce();
    expect(api.toggleMaximizeWindow).toHaveBeenCalledOnce();
    expect(api.closeWindow).toHaveBeenCalledOnce();
  });

  it("leaves macOS to the native traffic-light controls", () => {
    setElectronApi("darwin");
    const { container } = render(<WindowChrome />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("toolbar", { name: "Window controls" })).toBeNull();
  });
});
