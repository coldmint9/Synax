/** Offline CLI double used only by conversation-git-smoke --remote-fixture. */
const fs = require("node:fs");
const path = require("node:path");
const directory = path.dirname(process.argv[1]);
const filename = path.join(directory, "state.json");
const state = JSON.parse(fs.readFileSync(filename, "utf8"));
const args = process.argv.slice(2);
if (args[0] !== "api") throw new Error("Fixture only supports api");
const host = args[args.indexOf("--hostname") + 1];
const method = args[args.indexOf("--method") + 1];
const endpoint = args[args.indexOf("--method") + 2];
const github = host === "github.com";
if (!github && host !== "gitlab.com")
  throw new Error("Unexpected fixture host");
let input = {};
if (args.includes("--input")) input = JSON.parse(fs.readFileSync(0, "utf8"));
const row = github ? state.github : state.gitlab;
function output(value) {
  process.stdout.write(JSON.stringify(value));
}
if (method === "GET") {
  if (endpoint.includes("/check-runs"))
    output({
      check_runs: [
        { name: "unit-tests", status: "completed", conclusion: "success" },
      ],
    });
  else if (endpoint.includes("/status"))
    output({ statuses: [{ context: "lint", state: "success" }] });
  else if (endpoint.includes("/repository/branches/"))
    output({ commit: { id: state.baseSha } });
  else if (endpoint.includes("?state=")) output([row]);
  else if (/\/(pulls|merge_requests)\/7(?:\?|$)/.test(endpoint)) output(row);
  else throw new Error("Unexpected read " + endpoint);
} else if (method === "PUT" && endpoint.endsWith("/merge")) {
  row.state = github ? "closed" : "merged";
  row.merged = true;
  row.merged_at = new Date().toISOString();
  fs.writeFileSync(filename, JSON.stringify(state));
  output(github ? { merged: true, sha: row.head.sha } : row);
} else if (method === "PUT" && /\/(update-branch|rebase)$/.test(endpoint)) {
  output({ message: "Fixture branch update accepted" });
} else if (method === "POST" && /\/(pulls|merge_requests)$/.test(endpoint)) {
  row.title = input.title;
  row.body = input.body;
  row.description = input.description;
  row.draft = !!input.draft;
  fs.writeFileSync(filename, JSON.stringify(state));
  output(row);
} else throw new Error("Unexpected fixture write " + method + " " + endpoint);
