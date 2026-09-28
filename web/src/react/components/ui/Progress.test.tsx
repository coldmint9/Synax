import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Progress } from "./Progress";

describe("Progress", () => {
  it("exposes bounded progress to assistive technology", () => {
    render(<Progress aria-label="Indexing" value={150} />);
    expect(
      screen.getByRole("progressbar", { name: "Indexing" }),
    ).toHaveAttribute("aria-valuenow", "100");
  });
  it("does not advertise a false completion value while indeterminate", () => {
    render(<Progress aria-label="Working" value={50} indeterminate />);
    expect(screen.getByRole("progressbar")).not.toHaveAttribute(
      "aria-valuenow",
    );
  });
  it("keeps malformed range values finite", () => {
    render(<Progress aria-label="Progress" value={NaN} min={5} max={2} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuemin",
      "5",
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuemax",
      "105",
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "5",
    );
  });
});
