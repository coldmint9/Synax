import { asSchema } from "@ai-sdk/provider-utils";
import type { LlmGatewayMessage } from "../llm-runtime/types.js";
import type { LoopToolSet } from "./loop-ai-tools.js";
import { countTokens } from "./context-tokenizer.js";

export interface ContextComposition {
  tools: number;
  mcp: number;
  skills: number;
  messages: number;
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
}): Promise<ContextComposition> {
  const count = (text: string) => countTokens(text, input.model);
  const result: ContextComposition = {
    tools: 0,
    mcp: 0,
    skills: 0,
    messages: 0,
    total: 0,
    measuredAt: new Date().toISOString(),
  };
  for (const name of input.tools.activeTools) {
    const tool = input.tools.tools[name];
    const definition = {
      type: "function",
      name,
      description: tool.description,
      inputSchema: await asSchema(tool.inputSchema).jsonSchema,
    };
    const category = tool.metadata?.category === "mcp" ? "mcp" : "tools";
    result[category] += count(JSON.stringify(definition));
  }

  // Selected references share a prompt section with files/wiki. Only skill entries
  // belong to Skills; the JSON-quoted lines are the actual injected text.
  const skillSections = input.skillsSection ? [input.skillsSection] : [];
  for (const line of input.selectedReferences?.split("\n") ?? []) {
    try {
      if (JSON.parse(line)?.kind === "skill") skillSections.push(line);
    } catch {
      /* section heading */
    }
  }
  for (const message of input.messages) {
    result.messages += 4;
    if (typeof message.content === "string") {
      let text = message.content;
      if (message.role === "system") {
        for (const section of skillSections) {
          const index = text.indexOf(section);
          if (index < 0) continue;
          result.skills += count(section);
          text = text.slice(0, index) + text.slice(index + section.length);
        }
      }
      result.messages += count(text);
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text" || part.type === "reasoning") {
        result.messages += count(part.text);
      } else if (part.type === "tool-call") {
        result.messages +=
          8 + count(part.toolName) + count(JSON.stringify(part.input));
      } else if (part.type === "tool-result") {
        const output = part.output;
        const text = outputText(output);
        const skill =
          (input.tools.resolveToolId(part.toolName) ?? part.toolName) ===
            "skill.load" || part.toolName === "skill_load";
        const loaded =
          skill &&
          (output.type === "text" || output.type === "json") &&
          !text.startsWith("[Earlier skill.load result cleared");
        result.messages += 8 + count(part.toolName);
        result[loaded ? "skills" : "messages"] += count(text);
      }
      // Image/audio/file payloads are not text tokens. Do not tokenize base64 bytes
      // as if they were prompt text; provider-specific media billing is unavailable.
    }
  }
  result.total = result.tools + result.mcp + result.skills + result.messages;
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
