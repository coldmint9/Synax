import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Accordion, Card, Chip } from "@heroui/react";

describe("scratch heroui api", () => {
  it("exposes compound parts", () => {
    // eslint-disable-next-line no-console
    console.log("Accordion keys:", Object.keys(Accordion));
    // eslint-disable-next-line no-console
    console.log("Card keys:", Object.keys(Card));
    expect(Object.keys(Accordion).length).toBeGreaterThan(0);
  });

  it("renders accordion with heading and card slots", () => {
    render(
      <Card>
        <Card.Header>
          <Card.Title>Title</Card.Title>
          <Chip size="sm" variant="soft" color="success">
            Answered
          </Chip>
        </Card.Header>
        <Card.Content>
          <Accordion hideseparator className="w-full">
            <Accordion.Item id="one" aria-label="One">
              <Accordion.Heading>
                <Accordion.Trigger>
                  Trigger text
                  <Accordion.Indicator />
                </Accordion.Trigger>
              </Accordion.Heading>
              <Accordion.Panel>
                <Accordion.Body>Body text</Accordion.Body>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        </Card.Content>
      </Card>,
    );
    expect(screen.getByText("Title")).toBeTruthy();
    expect(screen.getByText("Body text")).toBeTruthy();
  });
});
