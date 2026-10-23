// One guardian per host. Ownership nonces survive fork/exec and setsid, so a
// build's detached JVMs are still owned even after their original shell exits.
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const groups = new Map();
let disconnected = false;
let scanning = false;
let timer;

function signal(pid, kind) {
  try { process.kill(pid, kind); } catch { /* checked again in the next snapshot */ }
}

async function processTable() {
  if (process.platform === "linux") {
    const entries = (await fs.readdir("/proc")).filter((name) => /^\d+$/.test(name));
    const rows = [];
    // Bound open files even on machines with thousands of processes.
    for (let offset = 0; offset < entries.length; offset += 32) {
      await Promise.all(entries.slice(offset, offset + 32).map(async (entry) => {
        try {
          const stat = await fs.readFile(`/proc/${entry}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
          const env = await fs.readFile(`/proc/${entry}/environ`, "utf8").catch(() => "");
          const owner = env.split("\0").find((value) => value.startsWith("SYNAX_PROCESS_OWNER="));
          rows.push({ pid: Number(entry), pgid: Number(fields[2]), state: fields[0], ownerId: owner?.slice("SYNAX_PROCESS_OWNER=".length) });
        } catch (error) {
          if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) throw error;
        }
      }));
    }
    return rows;
  }
  const { stdout } = await execFileAsync("/bin/ps", ["eww", "-axo", "pid=,pgid=,stat=,command="], {
    timeout: 3000, maxBuffer: 32 * 1024 * 1024,
  });
  // Environments may contain credentials. Extract only the nonce; never log
  // or send command lines/environment contents over IPC, including on errors.
  return stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) return [];
    return [{ pid: Number(match[1]), pgid: Number(match[2]), state: match[3],
      ownerId: match[4].match(/(?:^|\s)SYNAX_PROCESS_OWNER=([a-f0-9-]{36})(?:\s|$)/)?.[1] }];
  });
}

function reply(type, pid) {
  if (process.connected) process.send({ type, pid }, (error) => { if (error) shutdown(); });
}

function schedule(delayMs = 0) {
  if (timer || scanning || ![...groups.values()].some((group) => group.stopping)) return;
  timer = setTimeout(() => { timer = undefined; void sweep(); }, delayMs);
}

async function sweep() {
  scanning = true;
  // Only release groups present before the snapshot started. A later command
  // may have spawned a detached child while this snapshot was being collected.
  const pending = [...groups].filter(([, group]) => group.stopping);
  try {
    const rows = (await processTable()).filter((row) => !row.state.startsWith("Z"));
    for (const [pid, group] of pending) {
      const members = rows.filter((row) => row.pgid === pid || row.ownerId === group.ownerId);
      if (!members.length) {
        groups.delete(pid);
        reply("released", pid);
        continue;
      }
      const forced = Date.now() >= group.forceAt;
      for (const member of members) {
        if (member.pid <= 1 || member.pid === process.pid) continue;
        if (forced || !group.signalled.has(member.pid)) {
          signal(member.pid, forced ? "SIGKILL" : "SIGTERM");
          group.signalled.add(member.pid);
        }
      }
      if (Date.now() >= group.deadline && !group.reported) {
        group.reported = true;
      }
    }
  } catch {
    // Keep ownership and retry. A failed inspection is never proof of exit.
    for (const [pid, group] of pending) {
      signal(-pid, Date.now() >= group.forceAt ? "SIGKILL" : "SIGTERM");
      if (Date.now() >= group.deadline && !group.reported) {
        group.reported = true;
      }
    }
  } finally {
    scanning = false;
    if (disconnected && groups.size === 0) process.exit(0);
    const retrying = [...groups.values()].filter((group) => group.stopping);
    schedule(retrying.every((group) => group.reported) ? 1000 : 100);
  }
}

function stop(pid) {
  const group = groups.get(pid);
  if (!group || group.stopping) return;
  group.stopping = true;
  group.forceAt = Date.now() + 1500;
  group.deadline = Date.now() + 5000;
  signal(-pid, "SIGTERM");
  schedule();
}

function shutdown() {
  if (disconnected) return;
  disconnected = true;
  for (const pid of groups.keys()) stop(pid);
  if (groups.size === 0) process.exit(0);
}

process.on("message", (message) => {
  if (disconnected || !message || !Number.isSafeInteger(message.pid) || message.pid <= 1) return;
  if (message.type === "register" && typeof message.ownerId === "string" && /^[a-f0-9-]{36}$/.test(message.ownerId)) {
    if (!groups.has(message.pid)) groups.set(message.pid, { ownerId: message.ownerId, stopping: false, signalled: new Set() });
    reply("registered", message.pid);
  } else if (message.type === "release") stop(message.pid);
});
process.on("disconnect", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
if (!process.connected) shutdown();
