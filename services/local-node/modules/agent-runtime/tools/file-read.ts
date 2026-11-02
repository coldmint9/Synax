import * as z from "zod/v4";
import type { RegisteredTool } from "../contracts.js";
import {
  ensureSessionFileReadable,
  recordSessionFileRead,
} from "../read-tracker.js";
import { resolveWorkspacePath, toWorkspaceRelative } from "./workspace.js";
import { readFilePage } from "./file-read-page.js";
import { readPathMissResult } from "./read-path-probe.js";

const MAX_READ_BYTES = 64_000;

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".svg",
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
  ".mkv",
  ".flac",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".xz",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".o",
  ".a",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".sqlite",
  ".db",
  ".lock",
]);

function isBinaryPath(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

export const fileReadTool: RegisteredTool = {
  id: "file.read",
  label: "Read File",
  description:
    "Read a bounded UTF-8 page from an existing text file. Exact existing paths are accepted even when discovery state is cold; missing guessed paths return close workspace matches. Rejects directories and binary files. Large files return nextByteOffset and revision for safe continuation. Use rg first when you do not know the exact path; use media.read for images, audio, video or documents.",
  category: "read",
  mutability: "read",
  resumeBehavior: "auto",
  internalGate: "none",
  progressiveDetails:
    "Accepts { path: string, maxBytes?: number, byteOffset?: number, expectedRevision?: string, startLine?: number, lineCount?: number }. startLine is 1-based; lineCount defaults to 40 (effective cap 1000). Line mode cannot be combined with byteOffset; lineCount requires startLine. Line lookup scans at most 16 MiB; use byte pagination beyond that. Line results report startLine/endLine/lineCount and lineComplete; a false lineComplete means the last line is partial and cannot be copied into a patch yet. maxBytes is a requested page size with an effective cap of 64000; use nextByteOffset and expectedRevision for the next page. content contains only file text. Pages preserve UTF-8 boundaries; maxBytes values below 4 use an effective budget of 4 to guarantee progress. Byte-page I/O is bounded to the page plus a small binary sample; line mode additionally scans the bounded prefix.",
  inputSchema: z.object({
    path: z.string().min(1).describe("Existing file path relative to the session working directory, or an absolute path permitted by the sandbox. External paths may require approval."),
    maxBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Requested bytes per page (default ${MAX_READ_BYTES}; effective range 4–${MAX_READ_BYTES}). Larger requests are bounded, not rejected.`),
    byteOffset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Byte offset for a later page; use the previous result's nextByteOffset."),
    startLine: z.number().int().positive().optional()
      .describe("1-based first line for a bounded source excerpt; mutually exclusive with byteOffset."),
    lineCount: z.number().int().positive().optional()
      .describe("Requested lines when startLine is set (default 40, effective cap 1000); maxBytes still bounds the returned content."),
    expectedRevision: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("Revision returned by the previous page; required when byteOffset is non-zero so changed files are rejected."),
  }).superRefine((value, context) => {
    if (value.startLine !== undefined && value.byteOffset !== undefined)
      context.addIssue({ code: "custom", path: ["byteOffset"], message: "Cannot combine startLine and byteOffset." });
    if (value.lineCount !== undefined && value.startLine === undefined)
      context.addIssue({ code: "custom", path: ["startLine"], message: "Required when lineCount is supplied." });
    if (value.byteOffset !== undefined && value.byteOffset > 0 && !value.expectedRevision) {
      context.addIssue({ code: "custom", path: ["expectedRevision"], message: "Required when byteOffset is non-zero." });
    }
  }),
  getPattern(args) {
    return typeof args === "object" &&
      args &&
      "path" in args &&
      typeof (args as { path?: unknown }).path === "string"
      ? (args as { path: string }).path
      : undefined;
  },
  execute(input) {
    const args = input.args as {
      path?: string;
      maxBytes?: number;
      byteOffset?: number;
      expectedRevision?: string;
      startLine?: number;
      lineCount?: number;
    };
    if (!args?.path) throw new Error("path is required.");
    if (args.startLine !== undefined && args.byteOffset !== undefined)
      throw new Error("Cannot combine startLine and byteOffset.");
    if (args.lineCount !== undefined && args.startLine === undefined)
      throw new Error("startLine is required when lineCount is supplied.");
    const byteOffset = args.byteOffset ?? 0;
    if (byteOffset > 0 && !args.expectedRevision) {
      throw new Error("expectedRevision is required when byteOffset is non-zero. Use the revision returned by the previous file.read page.");
    }
    const miss = ensureSessionFileReadable(input.sessionId, args.path);
    if (miss) return readPathMissResult(miss);
    const filePath = resolveWorkspacePath(args.path, input.sessionId);
    if (isBinaryPath(filePath)) {
      throw new Error(
        `Refused: "${args.path}" appears to be a binary file. file.read only supports text files.`,
      );
    }

    const effectiveMaxBytes = Math.min(Math.max(args.maxBytes ?? MAX_READ_BYTES, 4), MAX_READ_BYTES);
    const effectiveLineCount = args.startLine === undefined ? undefined : Math.min(args.lineCount ?? 40, 1000);
    const page = readFilePage(filePath, byteOffset, effectiveMaxBytes, args.expectedRevision,
      args.startLine === undefined ? undefined : { startLine: args.startLine, lineCount: effectiveLineCount! });
    const relPath = toWorkspaceRelative(filePath, input.sessionId);
    // A page is not a whole-file snapshot. Metadata-only tracking fails closed
    // after metadata changes; full reads still support identical resaves.
    const completeRead = page.byteOffset === 0 && page.eof;
    recordSessionFileRead(input.sessionId, relPath, completeRead ? page.bytes : undefined, page.stat);
    const truncated = !page.eof;

    return {
      result: {
        path: relPath,
        content: page.content,
        truncated,
        totalBytes: page.stat.size,
        byteOffset: page.byteOffset,
        nextByteOffset: page.eof ? null : page.byteOffset + page.bytes.length,
        ...(page.startLine === undefined ? {} : {
          startLine: page.startLine, endLine: page.endLine, lineCount: page.lineCount,
          lineComplete: page.lineComplete, effectiveLineCount,
        }),
        eof: page.eof,
        bytesRead: page.bytes.length,
        revision: page.revision,
        effectiveMaxBytes,
      },
      displaySummary: `Read ${page.bytes.length} bytes at offset ${page.byteOffset} of ${page.stat.size} from ${relPath}${truncated ? " (more pages available)" : ""}.`,
      artifacts: [
        {
          kind: "evidence",
          title: "File read",
          summary: `Read ${relPath}.`,
          risk: "low",
        },
      ],
    };
  },
};
