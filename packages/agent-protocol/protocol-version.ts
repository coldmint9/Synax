export const agentProtocolVersion = "1" as const;

export function negotiateProtocolVersion(versions: readonly string[]): typeof agentProtocolVersion {
  if (!versions.includes(agentProtocolVersion)) {
    throw new Error("No compatible Agent protocol version");
  }
  return agentProtocolVersion;
}
