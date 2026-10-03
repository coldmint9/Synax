import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Tab, TabGroup, TabList, TabPanel, TabPanels } from "./Tabs";

describe("Headless tabs", () => {
  it("uses arrow-key roving focus, skips disabled tabs and links panels to their tabs", async () => {
    const user = userEvent.setup();
    render(
      <TabGroup>
        <TabList aria-label="Sources">
          <Tab>Local</Tab>
          <Tab disabled>Unavailable</Tab>
          <Tab>Existing</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>Local path</TabPanel>
          <TabPanel>Disabled content</TabPanel>
          <TabPanel>Project search</TabPanel>
        </TabPanels>
      </TabGroup>,
    );
    await user.tab();
    expect(screen.getByRole("tab", { name: "Local" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    const active = screen.getByRole("tab", { name: "Existing" });
    expect(active).toHaveFocus();
    expect(active).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel", { name: "Existing" });
    expect(panel).toHaveTextContent("Project search");
    expect(active).toHaveAttribute("aria-controls", panel.id);
  });
});
