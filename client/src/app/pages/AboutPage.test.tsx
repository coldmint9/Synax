import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AboutPage from "./AboutPage";
import { RuntimeSkeleton } from "../../features/runtime/RuntimeSkeleton";

describe("Synax product identity", () => {
  it("shows the enterprise repository and preserves upstream attribution", () => {
    const { container } = render(<AboutPage />);
    expect(screen.getByText("Synax")).toBeInTheDocument();
    expect(screen.getByText("Local-first AI coding workspace")).toBeInTheDocument();
    expect(screen.getByText("Licensed from coldmint9's Synax open-source project")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Synax Repository" })).toHaveAttribute(
      "href", "https://github.com/coldmint9/Synax",
    );
    expect(screen.getByText(/Copyright \(c\) 2026 Synax contributors/)).toHaveTextContent("Synax Team");
    expect(screen.queryByText(/SQLite|Drizzle|Vercel AI SDK/)).toBeNull();
    expect(screen.getByText("RocksDB")).toBeInTheDocument();
    expect(container.querySelector("img")).toHaveAttribute("src", "/synax-icon.svg");
    expect(screen.queryByText("S", { exact: true })).toBeNull();
  });

  it("names the loading workspace without exposing decorative skeleton elements", () => {
    render(<RuntimeSkeleton />);
    expect(screen.getByRole("main", { name: "Synax" })).toHaveAttribute("aria-busy", "true");
  });
});
