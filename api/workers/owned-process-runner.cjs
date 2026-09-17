// Trusted launcher: no project command runs until its PID and marker have been recorded.
const { spawn } = require("node:child_process");
let target;
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (!target) {
    process.exit(0);
    return;
  }
  if (process.platform === "win32")
    spawn("taskkill", ["/PID", String(target.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  else {
    try {
      process.kill(-process.pid, "SIGTERM");
    } catch {}
  }
  setTimeout(() => {
    if (process.platform !== "win32") {
      try {
        process.kill(-process.pid, "SIGKILL");
      } catch {}
    }
    process.exit(1);
  }, 1500).unref();
}
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.once("message", (message) => {
  if (stopping || !message || message.type !== "start") return;
  target = spawn(message.command, message.args, {
    cwd: message.cwd,
    shell: message.shell === true,
    stdio: ["inherit", "inherit", "inherit"],
    detached: false,
  });
  target.once("spawn", () => {
    if (process.connected) process.send({ type: "started" });
  });
  target.once("error", (error) => {
    process.stderr.write(`${error.code || "SPAWN_ERROR"}: ${error.message}\n`);
    process.exit(127);
  });
  target.once("exit", (code, signal) => {
    if (message.background && process.connected && !stopping) {
      process.send({ type: "finished", code, signal });
      // The owner kills the group after natural completion, including surviving descendants.
      return;
    }
    if (signal && process.platform !== "win32") {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else process.exit(code ?? 1);
  });
});
if (!process.connected) process.exit(0);
