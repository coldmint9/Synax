import { ZodError } from "zod/v4";

const MAX_ISSUES = 5;
const MAX_DIAGNOSTIC_LENGTH = 1_400;
const MAX_TOOL_ID_LENGTH = 96;
const MAX_PATH_SEGMENT_LENGTH = 64;

type ValidationIssue = {
  code: string;
  path: readonly unknown[];
  message: string;
  input?: unknown;
  expected?: unknown;
  origin?: unknown;
  maximum?: unknown;
  minimum?: unknown;
  format?: unknown;
  divisor?: unknown;
  inclusive?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidationIssue(value: unknown): value is ValidationIssue {
  if (!isRecord(value)) return false;
  return (
    typeof value.code === "string" &&
    Array.isArray(value.path) &&
    typeof value.message === "string"
  );
}

function readIssues(error: unknown): ValidationIssue[] | undefined {
  try {
    if (error instanceof ZodError) {
      return Array.isArray(error.issues) && error.issues.every(isValidationIssue)
        ? error.issues
        : undefined;
    }
    if (!isRecord(error) || error.name !== "ZodError") return undefined;
    return Array.isArray(error.issues) && error.issues.every(isValidationIssue)
      ? error.issues.map((issue) => issue as unknown as ValidationIssue)
      : undefined;
  } catch {
    return undefined;
  }
}

function safeLabel(value: string, limit: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit);
}

function formatPath(path: readonly unknown[]): string {
  if (path.length === 0) return "(root)";
  let result = "";
  for (const segment of path) {
    if (typeof segment === "number" && Number.isInteger(segment) && segment >= 0) {
      result += `[${segment}]`;
    } else if (typeof segment === "string") {
      const label = safeLabel(segment, MAX_PATH_SEGMENT_LENGTH);
      result += /^[A-Za-z_$][\w$]*$/.test(label)
        ? `${result ? "." : ""}${label}`
        : `[${label || "?"}]`;
    } else {
      result += "[?]";
    }
  }
  return result || "(root)";
}

function readPath(value: unknown, path: readonly unknown[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    if (typeof segment !== "string" && typeof segment !== "number") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(current, String(segment));
    if (!descriptor || !("value" in descriptor)) return undefined;
    current = descriptor.value;
  }
  return current;
}

function numeric(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  return undefined;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (typeof value === "number" && Number.isNaN(value)) return "nan";
  return typeof value;
}

function isWriteContentIssue(toolId: string, issue: ValidationIssue): boolean {
  const last = issue.path.at(-1);
  const field = typeof last === "string" ? last.toLowerCase() : "";
  const writeTool = /(?:^|[.:-])(write|patch|generate)(?:$|[.:-])/.test(toolId);
  return writeTool && ["content", "contents", "body", "text"].includes(field);
}

function numberFromIssueOrArgs(issue: ValidationIssue, args: unknown): string | undefined {
  return numeric(issue.input) ?? numeric(readPath(args, issue.path));
}

function formatIssue(toolId: string, args: unknown, issue: ValidationIssue): string {
  const code = safeLabel(issue.code, 40);
  const path = formatPath(issue.path);
  const details: string[] = [];
  let advice: string;

  switch (issue.code) {
    case "invalid_type": {
      const expected = typeof issue.expected === "string"
        ? safeLabel(issue.expected, 40)
        : "the required type";
      const received = typeName(issue.input === undefined ? readPath(args, issue.path) : issue.input);
      details.push(`expected ${expected}`);
      if (received) details.push(`received ${received}`);
      advice = `provide ${expected} for this field`;
      break;
    }
    case "too_big": {
      const maximum = numeric(issue.maximum);
      if (maximum !== undefined) details.push(`maximum ${maximum}${issue.inclusive === false ? ' (exclusive)' : ''}`);
      const received = issue.origin === "number" || issue.origin === "int"
        ? numberFromIssueOrArgs(issue, args)
        : undefined;
      if (received !== undefined) details.push(`received ${received}`);
      if (isWriteContentIssue(toolId, issue)) {
        advice = "shrink the write scope or split it into semantic operations; do not silently truncate or retry automatically";
      } else if (issue.origin === "array" || issue.origin === "set") {
        advice = "reduce the number of items in this operation";
      } else if (issue.origin === "number" || issue.origin === "int") {
        advice = "use a smaller number within the allowed limit";
      } else {
        advice = "shorten this field without echoing its value";
      }
      break;
    }
    case "too_small": {
      const minimum = numeric(issue.minimum);
      if (minimum !== undefined) details.push(`minimum ${minimum}${issue.inclusive === false ? ' (exclusive)' : ''}`);
      const received = issue.origin === "number" || issue.origin === "int"
        ? numberFromIssueOrArgs(issue, args)
        : undefined;
      if (received !== undefined) details.push(`received ${received}`);
      advice = issue.origin === "array" || issue.origin === "set"
        ? "provide more items when the operation semantically requires them"
        : issue.origin === "number" || issue.origin === "int"
          ? "use a number meeting the minimum"
          : "provide a non-empty value of the required size";
      break;
    }
    case "invalid_format": {
      const format = typeof issue.format === "string"
        ? safeLabel(issue.format, 40)
        : "the required format";
      details.push(`format ${format}`);
      advice = `use a value matching the ${format} format`;
      break;
    }
    case "not_multiple_of": {
      const divisor = numeric(issue.divisor);
      if (divisor !== undefined) details.push(`multiple of ${divisor}`);
      advice = "use a value satisfying the required numeric step";
      break;
    }
    case "unrecognized_keys":
      advice = "remove fields not present in the tool argument schema";
      break;
    case "invalid_value":
      advice = "choose one of the values allowed by the tool schema";
      break;
    case "invalid_union":
      advice = "provide arguments matching one supported input shape";
      break;
    case "custom":
      advice = toolId === "file.read" && issue.path.length === 1 && issue.path[0] === "expectedRevision"
        ? "for a non-zero byteOffset, supply the previous page's revision as expectedRevision; otherwise restart at byteOffset 0"
        : "adjust this field to satisfy the tool argument schema";
      break;
    default:
      advice = "adjust this field to satisfy the tool argument schema";
      break;
  }

  return `- [${code}] ${path}: ${details.length ? `${details.join(", ")}; ` : ""}${advice}.`;
}

function bound(text: string): string {
  if (text.length <= MAX_DIAGNOSTIC_LENGTH) return text;
  return `${text.slice(0, MAX_DIAGNOSTIC_LENGTH - 34).trimEnd()} … (diagnosis bounded)`;
}

/** Convert only confirmed Zod input failures into a bounded, value-safe diagnostic. */
export function formatToolInputError(
  toolId: string,
  args: unknown,
  error: unknown,
): string | undefined {
  const issues = readIssues(error);
  if (!issues || issues.length === 0) return undefined;

  const shown = issues.slice(0, MAX_ISSUES);
  const name = safeLabel(toolId, MAX_TOOL_ID_LENGTH) || "(unknown tool)";
  const lines = shown.map((issue) => formatIssue(name, args, issue));
  if (issues.length > shown.length) {
    lines.push(`- … ${issues.length - shown.length} additional validation issue(s) omitted.`);
  }
  return bound(`Tool input rejected for ${name} (${issues.length} issue(s)).\n${lines.join("\n")}`);
}
