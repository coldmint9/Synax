import { fromMarkdown } from "mdast-util-from-markdown";
import { z } from "zod";

export const prototypeManifestSchema = z
  .object({
    sourcePath: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.startsWith("\\") &&
          !/^[a-z]:/i.test(value) &&
          !value.split(/[\\/]/).includes(".."),
        "Use a workspace-relative path",
      ),
    title: z.string().trim().min(1).max(120),
    sourceKind: z.enum(["html", "react"]),
  })
  .strict();

export type PrototypeManifest = z.infer<typeof prototypeManifestSchema>;

/** Only complete, top-level prototype blocks are executable. */
export function prototypeDeclarations(
  content: string,
): Array<{ manifest: PrototypeManifest; start: number; end: number }> {
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) return [];
  const lines = content.split(/\r?\n/);
  const results: Array<{
    manifest: PrototypeManifest;
    start: number;
    end: number;
  }> = [];
  for (const node of fromMarkdown(content).children) {
    if (
      node.type !== "code" ||
      node.lang !== "synax-prototype" ||
      !node.position ||
      results.length >= 3
    )
      continue;
    const first = lines[node.position.start.line - 1];
    const last = lines[node.position.end.line - 1];
    const opening = /^ {0,3}(`{3,}|~{3,})synax-prototype\s*$/.exec(first);
    if (
      !opening ||
      node.position.end.line <= node.position.start.line ||
      !new RegExp(
        "^ {0,3}" + opening[1][0] + "{" + opening[1].length + ",}\\s*$",
      ).test(last)
    )
      continue;
    try {
      const parsed = prototypeManifestSchema.safeParse(JSON.parse(node.value));
      if (parsed.success)
        results.push({
          manifest: parsed.data,
          start: node.position.start.offset!,
          end: node.position.end.offset!,
        });
    } catch {
      // Invalid prototype declarations remain inert text.
    }
  }
  return results;
}

export const PROTOTYPE_AUTHORING_INSTRUCTIONS = `Interactive prototypes: write a self-contained HTML document or React/TSX entry inside the authorized workspace. No network, remote scripts, secrets, nested frames, Node APIs or build scripts. When the prototype is complete, emit up to three top-level complete fenced blocks tagged synax-prototype containing only JSON {"sourcePath":"prototypes/demo.tsx","title":"Demo","sourceKind":"react"}. The host compiles the referenced workspace files after a successful turn and inserts the resulting interactive preview into the conversation. There is no publish command, versioning, feedback, state persistence or export workflow. Prototype state is local to the current preview instance. Do not emit ordinary HTML fences or quoted examples. React source must export a default component. Declare sample data as demo data.`;

export function parsePrototypeManifests(content: string): PrototypeManifest[] {
  return prototypeDeclarations(content).map((item) => item.manifest);
}
