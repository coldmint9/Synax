import { resolveDevProfileEnvironment, type DevProfileTarget } from "./dev-profile-config.js";

type DevCommand = "all" | "local" | "client" | "desktop";

const [profile = "web-dev", command = "all"] = process.argv.slice(2) as [
  string?,
  DevCommand?,
];

if (!["all", "local", "client", "desktop"].includes(command)) {
  console.error(
    `Unknown development profile command: ${command}. Use "all", "local", "client", or "desktop".`,
  );
  process.exit(1);
}

const target: DevProfileTarget = command === "desktop" ? "desktop" : "client";
const profileEnvironment = resolveDevProfileEnvironment(profile, target);
Object.assign(process.env, profileEnvironment);

console.log(`[dev:${profile}] DATA_ROOT=${profileEnvironment.DATA_ROOT}`);
if (command === "all" || command === "local") {
  console.log(`[dev:${profile}] Local service http://localhost:${profileEnvironment.PORT}`);
}
if (command === "all" || command === "client" || command === "desktop") {
  console.log(`[dev:${profile}] Client http://localhost:${profileEnvironment.WEB_PORT}`);
}

const entrypoint = {
  all: "./dev-all.ts",
  local: "./dev-local.ts",
  client: "./dev-client.ts",
  desktop: "./dev-desktop.ts",
}[command];

await import(entrypoint);
