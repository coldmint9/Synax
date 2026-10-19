// One guardian per host, shared by all POSIX command groups. It survives a host
// crash long enough to terminate the registered groups, then exits itself.
const groups = new Map();
let disconnected = false;

function signal(pid, kind) {
  try {
    process.kill(-pid, kind);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function forget(pid) {
  clearInterval(groups.get(pid)?.timer);
  groups.delete(pid);
  if (process.connected) process.send({ type: "released", pid }, (error) => {
    if (error) shutdown();
  });
  if (disconnected && groups.size === 0) process.exit(0);
}

function stop(pid) {
  const group = groups.get(pid);
  if (!group || group.timer) return;
  if (!signal(pid, "SIGTERM")) return forget(pid);
  const deadline = Date.now() + 1500;
  group.timer = setInterval(() => {
    if (!signal(pid, 0)) return forget(pid);
    if (Date.now() >= deadline) {
      signal(pid, "SIGKILL");
      forget(pid);
    }
  }, 25);
}

function shutdown() {
  if (disconnected) return;
  disconnected = true;
  for (const pid of groups.keys()) stop(pid);
  if (groups.size === 0) process.exit(0);
}

process.on("message", (message) => {
  if (disconnected || !message || !Number.isSafeInteger(message.pid) || message.pid <= 1) return;
  if (message.type === "register") {
    if (!groups.has(message.pid)) groups.set(message.pid, { timer: undefined });
    process.send({ type: "registered", pid: message.pid }, (error) => {
      if (error) shutdown();
    });
  } else if (message.type === "release") {
    stop(message.pid);
  }
});
process.on("disconnect", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
if (!process.connected) shutdown();
