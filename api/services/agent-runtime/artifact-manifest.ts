import { fromMarkdown } from "mdast-util-from-markdown";
import { z } from "zod";
export const publishArtifactSchema = z
  .object({
    sourcePath: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (p) =>
          !p.startsWith("/") &&
          !p.startsWith("\\") &&
          !/^[a-z]:/i.test(p) &&
          !p.split(/[\\/]/).includes(".."),
        "Use a workspace-relative path",
      ),
    title: z.string().trim().min(1).max(120),
    sourceKind: z.enum(["html", "react"]),
    artifactId: z.string().max(100).optional(),
    baseRevisionId: z.string().max(100).optional(),
    idempotencyKey: z.string().min(1).max(180),
  })
  .strict();
const manifestSchema = publishArtifactSchema.omit({ idempotencyKey: true });
/** Only explicit, fully closed, top-level blocks; outer code fences stay literal. */
export function parseArtifactManifests(
  content: string,
): Array<z.infer<typeof manifestSchema>> {
  const results: Array<z.infer<typeof manifestSchema>> = [];
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) return results;
  const lines = content.split(/\r?\n/);
  for (const node of fromMarkdown(content).children) {
    if (
      node.type !== "code" ||
      node.lang !== "synax-artifact" ||
      !node.position ||
      results.length >= 5
    )
      continue;
    const first = lines[node.position.start.line - 1];
    const last = lines[node.position.end.line - 1];
    const opening = /^ {0,3}(`{3,}|~{3,})synax-artifact\s*$/.exec(first);
    if (
      !opening ||
      node.position.end.line <= node.position.start.line ||
      !new RegExp(
        "^ {0,3}" + opening[1][0] + "{" + opening[1].length + ",}\\s*$",
      ).test(last)
    )
      continue;
    try {
      const parsed = manifestSchema.safeParse(JSON.parse(node.value));
      if (parsed.success) results.push(parsed.data);
    } catch {
      /* invalid manifests stay inert */
    }
  }
  return results;
}
export const ARTIFACT_AUTHORING_INSTRUCTIONS = `Interactive deliverables: write a self-contained HTML document (or a React/TSX entry) inside this workspace. No network, remote scripts or dependencies, secrets, nested frames, Node APIs or build scripts. Use artifact.publish when provided, with sourcePath,title,sourceKind,idempotencyKey; revisions also require artifactId and baseRevisionId. For external backends without this tool, emit one top-level complete fenced block tagged synax-artifact containing ONLY JSON {"sourcePath":"prototypes/demo.html","title":"Demo","sourceKind":"html"}. The host validates and publishes on successful turn completion; never claim it succeeded before confirmation. Do not publish ordinary HTML fences or quoted examples. Prototype interactions use window.synaxWidget: ready(), getState(), setState({privateState,modelState}), registerControls([...]), onControlsChange(fn), reportHeight(px), requestFeedbackDraft({text,modelState}). Controls use {key,label,type,defaultValue,min?,max?,step?,options?:[{label,value}]} with types select/toggle/range/number/color/text. State is <=16KiB. Feedback suggestions are drafts requiring user confirmation; no privileged calls. HTML runs after the provided SDK; React source exports a default component. Declare sample data as demo data. Publication reads only the authorized workspace and does not grant execution, network or file privileges to the generated UI.`;
