import { describe, expect, it } from "vitest";
import {
  detectToolCallTextArtifact,
  type ToolCallTextMarker,
} from "../tool-call-text.js";

/** The exact answer a child returned on 2026-10-30 before it "completed". */
const INCIDENT_ANSWER = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="agent_execute">
<｜｜DSML｜｜ parameter name="code" string="true">const r = await Promise.all([
  tools.call('file.list', {path: 'services/local-node/infrastructure'}),
  tools.call('shell.exec', {command: "ls services/local-node/infrastructure/runtime/", workdir: '/Users/mint/workspace/demo'}),
]);
return r;</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;

describe("detectToolCallTextArtifact", () => {
  it("recognises the DSML block that ended the child run", () => {
    expect(detectToolCallTextArtifact(INCIDENT_ANSWER)).toMatchObject({
      marker: "dsml",
    });
  });

  it("recognises the block behind one short lead-in sentence", () => {
    expect(
      detectToolCallTextArtifact(`I'll inspect the module now.\n\n${INCIDENT_ANSWER}`),
    ).toMatchObject({ marker: "dsml" });
  });

  it("recognises the legacy and fenced encodings", () => {
    const cases: Array<[string, ToolCallTextMarker]> = [
      ['<|tool▁calls▁begin|>{"name":"bash"}', "legacy"],
      ['```xml\ninvoke name="bash"\n```', "invoke"],
      ['```\n<invoke name="bash">', "invoke"],
    ];
    for (const [text, marker] of cases)
      expect(detectToolCallTextArtifact(text), text).toMatchObject({ marker });
  });

  it("leaves ordinary answers alone", () => {
    for (const text of [
      "All three ledger tests pass; nothing changed in the runtime.",
      "I updated session-store.ts and ran the suite: 21 passed.",
      "",
      "   ",
      null,
      undefined,
    ])
      expect(detectToolCallTextArtifact(text), String(text)).toBeNull();
  });

  it("ignores a report that quotes the markers after its opening lines", () => {
    const report = [
      "## Root cause",
      "The gateway returned the tool call as text.",
      "x".repeat(220),
      INCIDENT_ANSWER,
    ].join("\n");
    expect(detectToolCallTextArtifact(report)).toBeNull();
  });

  it("keeps the excerpt bounded", () => {
    const artifact = detectToolCallTextArtifact(INCIDENT_ANSWER)!;
    expect(artifact.excerpt.length).toBeLessThanOrEqual(120);
  });
});
