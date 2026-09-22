import type { AgentRuntimeMessage } from "../../../lib/api/agentRuntime";

export interface InteractivePrototypeReference {
  id: string;
  title: string;
  sourceKind: "html" | "react";
  html: string;
}

export interface PrototypeDiagnostic {
  title: string;
  code: string;
  message: string;
}

export function messagePrototypes(
  message: AgentRuntimeMessage,
): InteractivePrototypeReference[] {
  if (
    message.role !== "assistant" ||
    message.metadata?.source !== "interactive_prototype" ||
    !Array.isArray(message.metadata.prototypes)
  )
    return [];
  return message.metadata.prototypes.slice(0, 3).flatMap((value: unknown) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      typeof item.title !== "string" ||
      typeof item.html !== "string" ||
      !["html", "react"].includes(String(item.sourceKind))
    )
      return [];
    return [item as unknown as InteractivePrototypeReference];
  });
}

export function messagePrototypeDiagnostics(
  message: AgentRuntimeMessage,
): PrototypeDiagnostic[] {
  if (
    message.role !== "assistant" ||
    message.metadata?.source !== "interactive_prototype" ||
    !Array.isArray(message.metadata.prototypeDiagnostics)
  )
    return [];
  return message.metadata.prototypeDiagnostics
    .slice(0, 3)
    .flatMap((value: unknown) => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      return typeof item.title === "string" &&
        typeof item.code === "string" &&
        typeof item.message === "string"
        ? [item as unknown as PrototypeDiagnostic]
        : [];
    });
}
