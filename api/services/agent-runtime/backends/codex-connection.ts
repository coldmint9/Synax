import { StdioRpc } from "./stdio-rpc.js";

export type Json = Record<string, unknown>;
export const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
export const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
export const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

async function initialize(rpc: StdioRpc): Promise<string> {
  const result = object(
    await rpc.request("initialize", {
      clientInfo: { name: "synax", title: "Synax", version: "1.0.4" },
      capabilities: { experimentalApi: true },
    }),
  );
  rpc.notify("initialized");
  return string(result.userAgent);
}

export async function openCodex(
  workDir: string,
  inheritTools = false,
  signal?: AbortSignal,
): Promise<{
  rpc: StdioRpc;
  config: Json;
  version: string;
  isolated: boolean;
}> {
  const base = ["app-server", "--listen", "stdio://"];
  const safety = [
    "-c",
    "notify=[]",
    "-c",
    "features.hooks=false",
    "-c",
    "features.apps=false",
  ];
  let rpc = new StdioRpc(
    "codex",
    [...base, ...(inheritTools ? [] : safety)],
    workDir,
  );
  const stop = () => {
    void rpc.stop().catch(() => {});
  };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    if (signal?.aborted) throw new Error("Codex connection cancelled.");
    let version = await initialize(rpc);
    let config = object(
      object(
        await rpc.request("config/read", {
          cwd: workDir,
          includeLayers: false,
        }),
      ).config,
    );
    if (!inheritTools) {
      const overrides: string[] = [];
      for (const section of ["mcp_servers", "plugins"]) {
        const names = Object.keys(object(config[section]));
        // Override an inline TOML table, not dotted CLI paths: server/plugin names may contain dots.
        if (names.length)
          overrides.push(
            "-c",
            `${section}={${names.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`,
          );
      }
      for (const [name, value] of Object.entries(object(config.hooks)))
        if (Array.isArray(value)) overrides.push("-c", `hooks.${name}=[]`);
      await rpc.stop();
      if (signal?.aborted) throw new Error("Codex connection cancelled.");
      rpc = new StdioRpc("codex", [...base, ...safety, ...overrides], workDir);
      version = await initialize(rpc);
      config = object(
        object(
          await rpc.request("config/read", {
            cwd: workDir,
            includeLayers: false,
          }),
        ).config,
      );
      const enabled = ["mcp_servers", "plugins"].some((section) =>
        Object.values(object(config[section])).some(
          (value) => object(value).enabled !== false,
        ),
      );
      const hooks = Object.values(object(config.hooks)).some(
        (value) => Array.isArray(value) && value.length > 0,
      );
      if (enabled || hooks)
        throw new Error(
          "Codex did not confirm isolated MCP/plugin/hook configuration.",
        );
    }
    return { rpc, config, version, isolated: !inheritTools };
  } catch (error) {
    await rpc.stop();
    throw error;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}
