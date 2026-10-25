import { useEffect, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SessionSidePanel } from "../SessionSidePanel";

it("hosts an additional view without feature-specific branches and preserves inactive content", () => {
  const subscribe = vi.fn();
  const unsubscribe = vi.fn();
  function BrowserView() {
    const [address, setAddress] = useState("https://example.com");
    useEffect(() => {
      subscribe();
      return unsubscribe;
    }, []);
    return (
      <input
        aria-label="Browser address"
        value={address}
        onChange={(event) => setAddress(event.target.value)}
      />
    );
  }
  const resizeBrowser = vi.fn();
  const resizeCards = vi.fn();
  function Harness() {
    const [active, setActive] = useState<string | null>("browser");
    return (
      <>
        <button onClick={() => setActive("browser")}>Browser</button>
        <button onClick={() => setActive("cards")}>Cards</button>
        <button onClick={() => setActive(null)}>Hide panel</button>
        <SessionSidePanel
          activeViewId={active}
          minWidth={240}
          maxWidth={960}
          views={[
            {
              id: "browser",
              label: "Browser",
              width: 640,
              content: <BrowserView />,
              onResize: resizeBrowser,
              onResizeKeyDown: resizeBrowser,
            },
            {
              id: "cards",
              label: "Cards",
              width: 300,
              content: <p>Card content</p>,
              onResize: resizeCards,
              onResizeKeyDown: resizeCards,
            },
          ]}
        />
      </>
    );
  }
  const { container } = render(<Harness />);
  const host = container.querySelector("aside");
  const address = screen.getByRole("textbox", { name: "Browser address" });
  fireEvent.change(address, { target: { value: "https://example.com/docs" } });
  fireEvent.pointerDown(screen.getByRole("separator"));
  expect(resizeBrowser).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Cards" }));
  expect(host).toHaveStyle({ width: "300px" });
  expect(address).not.toBeVisible();
  expect(unsubscribe).toHaveBeenCalledOnce();
  fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
  expect(resizeCards).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Hide panel" }));
  expect(host).not.toBeVisible();
  expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Browser" }));
  expect(container.querySelector("aside")).toBe(host);
  expect(host).toHaveStyle({ width: "640px" });
  expect(screen.getByRole("textbox")).toBe(address);
  expect(address).toHaveValue("https://example.com/docs");
  expect(subscribe).toHaveBeenCalledTimes(2);
});
