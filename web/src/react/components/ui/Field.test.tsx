import { createRef, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  Description,
  Field,
  FieldError,
  Input,
  InputGroup,
  InputPrefix,
  InputSuffix,
  Label,
  TextArea,
} from "./Field";

describe("Headless UI fields", () => {
  it("connects labels, descriptions and validation errors to the input", async () => {
    const user = userEvent.setup();
    render(
      <Field invalid>
        <Label>API key</Label>
        <Input required />
        <Description>Stored locally</Description>
        <FieldError>Key is required</FieldError>
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "API key" });
    expect(input).toHaveAccessibleDescription("Stored locally Key is required");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toBeRequired();
    await user.click(screen.getByText("API key"));
    expect(input).toHaveFocus();
  });

  it("forwards ref and native controlled events through grouped inputs", async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLInputElement>();
    function Example() {
      const [value, setValue] = useState("");
      return (
        <Field>
          <Label>Endpoint</Label>
          <InputGroup>
            <InputPrefix>https://</InputPrefix>
            <Input
              ref={ref}
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
            <InputSuffix>.test</InputSuffix>
          </InputGroup>
        </Field>
      );
    }
    render(<Example />);
    const input = screen.getByRole("textbox", { name: "Endpoint" });
    await user.type(input, "synax");
    expect(input).toHaveValue("synax");
    expect(ref.current).toBe(input);
  });

  it("inherits disabled state without leaking field-only props to the DOM", () => {
    render(
      <Field disabled invalid>
        <Label>Notes</Label>
        <TextArea />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Notes" });
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).not.toHaveAttribute("invalid");
  });

  it("keeps standalone inputs usable with native aria labels and descriptions", () => {
    render(
      <>
        <Input aria-label="Search" aria-describedby="search-help" />
        <Description id="search-help">Filter results</Description>
      </>,
    );
    expect(
      screen.getByRole("textbox", { name: "Search" }),
    ).toHaveAccessibleDescription("Filter results");
  });
});
