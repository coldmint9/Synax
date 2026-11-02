import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImageViewer } from "./ImageViewer";

const SRC = "data:image/png;base64,iVBORw0KGgo=";

describe("ImageViewer", () => {
  it("exposes zoom in, zoom out and fit controls", () => {
    const onClose = vi.fn();
    render(<ImageViewer src={SRC} alt="screenshot.png" onClose={onClose} />);

    expect(
      screen.getByRole("dialog", { name: "screenshot.png" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "100%" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "适应窗口" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(screen.getByRole("button", { name: "150%" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "适应窗口" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "缩小" }));
    expect(screen.getByRole("button", { name: "100%" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    fireEvent.click(screen.getByRole("button", { name: "适应窗口" }));
    expect(screen.getByRole("button", { name: "100%" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭图片预览" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("zooms with the keyboard and clamps at the smallest level", () => {
    render(<ImageViewer src={SRC} alt="diagram.png" onClose={vi.fn()} />);
    const image = screen.getByRole("img", { name: "diagram.png" });

    fireEvent.keyDown(image, { key: "+" });
    expect(screen.getByRole("button", { name: "150%" })).toBeInTheDocument();
    for (let i = 0; i < 8; i += 1)
      fireEvent.click(screen.getByRole("button", { name: "缩小" }));
    expect(screen.getByRole("button", { name: "25%" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "缩小" })).toBeDisabled();

    fireEvent.keyDown(image, { key: "0" });
    expect(screen.getByRole("button", { name: "100%" })).toBeInTheDocument();
  });
});
