import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge, Card, Separator, Spinner } from "./Display";

describe("semantic display primitives", () => {
  it("preserves card content and accessible section headings without private slots", () => {
    render(
      <Card aria-labelledby="card-title">
        <header>
          <h3 id="card-title">Title</h3>
          <Badge tone="success">Answered</Badge>
        </header>
        <p>Body text</p>
      </Card>,
    );
    expect(screen.getByRole("region", { name: "Title" })).toHaveTextContent(
      "Body text",
    );
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.getByText("Answered")).not.toHaveAttribute("tone");
  });
  it("exposes separator orientation and loading status", () => {
    render(
      <>
        <Separator orientation="vertical" />
        <Spinner aria-label="Loading models" />
      </>,
    );
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-orientation",
      "vertical",
    );
    expect(
      screen.getByRole("status", { name: "Loading models" }),
    ).toBeInTheDocument();
  });
});
