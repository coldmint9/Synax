import { resolveDevProfileEnvironment, type DevProfileTarget } from "./dev-profile-config.js";

type DevCommand = "all" | "api" | "web" | "desktop";

const [profile = "web-dev", command = "all"] = process.argv.slice(2) as [
  string?,
  DevCommand?,
];

if (!["all", "api", "web", "desktop"].includes(command)) {
  console.error(
    `Unknown development profile command: ${command}. Use "all", "api", "web", or "desktop".`,
  );
  process.exit(1);
}

const target: DevProfileTarget = command === "desktop" ? "desktop" : "web";
const profileEnvironment = resolveDevProfileEnvironment(profile, target);
Object.assign(process.env, profileEnvironment);

console.log(`[dev:${profile}] DATA_ROOT=${profileEnvironment.DATA_ROOT}`);
if (command === "all" || command === "api") {
  console.log(`[dev:${profile}] API http://localhost:${profileEnvironment.PORT}`);
}
if (command === "all" || command === "web" || command === "desktop") {
  console.log(`[dev:${profile}] Web http://localhost:${profileEnvironment.WEB_PORT}`);
}

const entrypoint = {
  all: "./dev-all.ts",
  api: "./dev-api.ts",
  web: "./dev-web.ts",
  desktop: "./dev-desktop.ts",
}[command];

await import(entrypoint);
