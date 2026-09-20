import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { DesktopBackground } from "../DesktopBackground";
import { useDesktopAppearance } from "../../state/desktopAppearanceStore";

beforeEach(() => {
  useDesktopAppearance.setState({ settings: {
    opacity: 1, blur: 12, frost: 50, fit: "cover", background: null,
    opacitySupported: true, layeredBackground: true,
  } });
});
it("keeps an adjustable background plane even without a wallpaper", () => {
  const { container, unmount } = render(<><DesktopBackground /><main>Clear cards</main></>);
  const foreground = screen.getByText("Clear cards");
  expect(document.documentElement).toHaveClass("has-desktop-surface", "has-native-background");
  expect(document.documentElement).not.toHaveClass("has-desktop-background");
  const layer = container.querySelector<HTMLElement>(".desktop-background")!;
  expect(layer.contains(foreground)).toBe(false);
  act(() => useDesktopAppearance.setState(state => ({ settings: { ...state.settings!, opacity: 0.4, frost: 90 } })));
  expect(layer.style.getPropertyValue("--background-opacity")).toBe("0.4");
  expect(foreground.style.opacity).toBe("");
  expect(container.querySelector("main")).toBe(foreground);
  unmount();
  expect(document.documentElement).not.toHaveClass("has-native-background", "has-desktop-surface");
});
it("reuses its image node during opacity changes and removes only the wallpaper", () => {
  act(() => useDesktopAppearance.setState(state => ({ settings: { ...state.settings!, background: {asset:"a.png",url:"synax-background://local/a.png",name:"a.png",width:100,height:100} } })));
  const { container } = render(<DesktopBackground />);
  const image = container.querySelector<HTMLElement>(".desktop-background__image")!;
  const style = image.getAttribute("style");
  act(() => useDesktopAppearance.setState(state => ({ settings: { ...state.settings!, opacity: 0.6 } })));
  expect(container.querySelector(".desktop-background__image")).toBe(image);
  expect(image.getAttribute("style")).toBe(style);
  act(() => useDesktopAppearance.setState(state => ({ settings: { ...state.settings!, background: null } })));
  expect(container.querySelector(".desktop-background__paint")).toBeInTheDocument();
  expect(document.documentElement).not.toHaveClass("has-desktop-background");
});
it("does not expose the native desktop on an unsupported system", () => {
  useDesktopAppearance.setState(state => ({ settings: { ...state.settings!, opacitySupported: false } }));
  render(<DesktopBackground />);
  expect(document.documentElement).not.toHaveClass("has-native-background");
});
