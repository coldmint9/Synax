import { asSchema } from "@ai-sdk/provider-utils";
import type { LlmGatewayMessage } from "../llm-runtime/types.js";
import type { LoopToolSet } from "./loop-ai-tools.js";
import { countTokens } from "./context-tokenizer.js";
import type { ToolCallRecord } from "./contracts.js";

export interface ContextComposition {
  /** v2 separates retained call context from conversational text. */
  version?: 2;
  tools: number;
  mcp: number;
  skills: number;
  messages: number;
  system?: number;
  /** Retained call/loaded content, a subset of each category's total. */
  usage?: { tools: number; mcp: number; skills: number };
  total: number;
  measuredAt: string;
}

/** A text/schema estimate of this request, not cumulative or provider-billed usage. */
export async function measureContextComposition(input: {
  messages: LlmGatewayMessage[];
  tools: LoopToolSet;
  model?: string;
  skillsSection?: string | null;
  selectedReferences?: string;
  systemMessageContents?: ReadonlySet<string>;
  toolCalls?: ReadonlyArray<
    Pick<ToolCallRecord, "id" | "modelToolCallId" | "toolId" | "category">
  >;
}): Promise<ContextComposition> {
  const count = (text: string) => countTokens(text, input.model);
  const result = {
    version: 2 as const,
    tools: 0,
    mcp: 0,
    skills: 0,
    messages: 0,
    system: 0,
    usage: { tools: 0, mcp: 0, skills: 0 },
    total: 0,
    measuredAt: new Date().toISOString(),
  };
  const addContent = (
    category: "tools" | "mcp" | "skills" | "messages" | "system",
    tokens: number,
  ) => {
    result[category] += tokens;
    if (category === "tools" || category === "mcp" || category === "skills")
      result.usage[category] += tokens;
  };
  const bucket = (category: unknown, toolId: string) =>
    category === "mcp" || /^mcp[._]/.test(toolId)
      ? ("mcp" as const)
      : category === "skill" ||
          toolId === "skill.load" ||
          toolId === "skill_load"
        ? ("skills" as const)
        : ("tools" as const);
  const callCategories = new Map(
    (input.toolCalls ?? []).map((call) => [
      String(call.modelToolCallId ?? call.id),
      bucket(call.category, call.toolId),
    ]),
  );
  const toolCategory = (name: string, callId?: string) => {
    const recorded = callId ? callCategories.get(callId) : undefined;
    if (recorded) return recorded;
    const id = input.tools.resolveToolId(name) ?? name;
    const modelName = input.tools.resolveModelToolName(id) ?? name;
    return bucket(input.tools.tools[modelName]?.metadata?.category, id);
  };
  for (const message of input.messages) {
    if (Array.isArray(message.content))
      for (const part of message.content) {
        if (part.type === "tool-call" || part.type === "tool-result")
          callCategories.set(
            part.toolCallId,
            toolCategory(part.toolName, part.toolCallId),
          );
      }
  }
  for (const name of input.tools.activeTools) {
    const tool = input.tools.tools[name];
    const definition = {
      type: "function",
      name,
      description: tool.description,
      inputSchema: await asSchema(tool.inputSchema).jsonSchema,
    };
    const category = toolCategory(name);
    result[category] += count(JSON.stringify(definition));
  }

  // Selected references share a prompt section with files/wiki. Only skill entries
  // belong to Skills; the JSON-quoted lines are the actual injected text.
  const skillSections = input.skillsSection
    ? [{ text: input.skillsSection, used: false }]
    : [];
  for (const line of input.selectedReferences?.split("\n") ?? []) {
    try {
      if (JSON.parse(line)?.kind === "skill")
        skillSections.push({ text: line, used: true });
    } catch {
      /* section heading */
    }
  }
  for (const message of input.messages) {
    // Role/message envelopes are protocol overhead, not conversational text.
    result.system += 4;
    const mediaCallId = message.providerOptions?.synax?.toolCallId;
    const mediaCategory =
      typeof mediaCallId === "string"
        ? callCategories.get(mediaCallId)
        : undefined;
    const textCategory = (text: string) =>
      mediaCategory ??
      (message.role === "system" || input.systemMessageContents?.has(text)
        ? "system"
        : "messages");
    if (typeof message.content === "string") {
      let text = message.content;
      if (message.role === "system") {
        for (const section of skillSections) {
          const index = text.indexOf(section.text);
          if (index < 0) continue;
          const tokens = count(section.text);
          result.skills += tokens;
          if (section.used) result.usage.skills += tokens;
          text = text.slice(0, index) + text.slice(index + section.text.length);
        }
      }
      addContent(textCategory(text), count(text));
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text" || part.type === "reasoning") {
        addContent(textCategory(part.text), count(part.text));
      } else if (part.type === "tool-call") {
        addContent(
          toolCategory(part.toolName, part.toolCallId),
          8 + count(part.toolName) + count(JSON.stringify(part.input ?? {})),
        );
      } else if (part.type === "tool-result") {
        const output = part.output;
        const text = outputText(output);
        addContent(
          toolCategory(part.toolName, part.toolCallId),
          8 + count(part.toolName) + count(text),
        );
      }
      // Image/audio/file payloads are not text tokens. Do not tokenize base64 bytes
      // as if they were prompt text; provider-specific media billing is unavailable.
    }
  }
  result.total =
    result.tools + result.mcp + result.skills + result.messages + result.system;
  return result;
}

function outputText(output: {
  type: string;
  value?: unknown;
  reason?: string;
}): string {
  if (output.type === "json" || output.type === "error-json")
    return JSON.stringify(output.value) ?? "";
  if (typeof output.value === "string") return output.value;
  if (output.type === "content" && Array.isArray(output.value)) {
    return output.value
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
  }
  return output.reason ?? "";
}
