// Self-contained sandbox preload. No main-world Electron API or generic IPC is exposed.
// The SDK uses the same JSON envelope as its web iframe handshake, via window messages.
{
  const { ipcRenderer } = require("electron") as typeof import("electron");
  const arg = process.argv.find((value) =>
    value.startsWith("--synax-artifact="),
  );
  let binding: { id: string; nonce: string; prototypeId: string } | undefined;
  try {
    binding = JSON.parse(
      Buffer.from(
        arg?.slice("--synax-artifact=".length) || "",
        "base64",
      ).toString("utf8"),
    );
  } catch {
    /* Fail closed. */
  }
  const runtimeTypes = new Set(["hello", "ready", "resize"]);
  const hostTypes = new Set(["connect", "response", "theme"]);
  function valid(
    value: unknown,
    types: Set<string>,
  ): value is Record<string, unknown> {
    if (!binding || !value || typeof value !== "object" || Array.isArray(value))
      return false;
    const v = value as Record<string, unknown>;
    return (
      v.protocol === 1 &&
      v.instanceId === binding.id &&
      v.nonce === binding.nonce &&
      v.prototypeId === binding.prototypeId &&
      typeof v.type === "string" &&
      types.has(v.type)
    );
  }
  // Rate-limit before crossing process boundaries too. Main independently enforces quotas.
  let tokens = 40,
    at = Date.now();
  window.addEventListener("message", (event) => {
    if (event.source !== window || !valid(event.data, runtimeTypes)) return;
    const now = Date.now();
    tokens = Math.min(40, tokens + Math.max(0, now - at) * 0.02);
    at = now;
    if (tokens < 1) return;
    tokens--;
    try {
      const json = JSON.stringify(event.data);
      if (!json || Buffer.byteLength(json, "utf8") > 32768) return;
      ipcRenderer.send("artifact-runtime:message", JSON.parse(json));
    } catch {
      /* Cyclic or unsupported structured data is not a transport message. */
    }
  });
  ipcRenderer.on("artifact-runtime:message", (_event, message: unknown) => {
    if (valid(message, hostTypes)) window.postMessage(message, "*");
  });
  // Isolated-world callback shares the renderer thread. A tight loop cannot fake its health.
  ipcRenderer.on("artifact-runtime:ping", (_event, challenge: unknown) => {
    if (typeof challenge === "string" && challenge.length <= 64)
      ipcRenderer.send("artifact-runtime:pong", challenge);
  });
}
