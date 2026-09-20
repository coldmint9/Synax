import type { UpdaterAction, UpdaterState } from "./contract.js";
declare global {
  interface Window {
    synaxUpdater: {
      state(): Promise<UpdaterState>;
      action(action: UpdaterAction): Promise<UpdaterState>;
      subscribe(callback: (state: UpdaterState) => void): () => void;
    };
  }
}
const element = (id: string) => document.getElementById(id)!;
const button = (id: string) => element(id) as HTMLButtonElement;
function render(state: UpdaterState): void {
  element("current").textContent = state.currentVersion;
  element("ui-version").textContent = state.uiVersion ?? "随应用提供";
  element("latest").textContent = state.availableVersion ?? "—";
  element("message").textContent = state.message;
  element("message").className =
    state.phase === "error" ? "message error" : "message";
  element("notes").textContent =
    state.notes || "检查新版本后，可在这里查看更新说明。";
  element("size").textContent = state.size
    ? `${Math.ceil(state.size / 1024 ** 2)} MB · 完整应用更新`
    : "包含内核、后台服务和界面";
  const progress = element("progress") as HTMLProgressElement;
  progress.hidden = !["checking", "downloading", "installing"].includes(
    state.phase,
  );
  if (state.phase === "downloading") progress.value = state.progress;
  else progress.removeAttribute("value");
  element("percent").textContent =
    state.phase === "downloading" ? `${Math.round(state.progress * 100)}%` : "";
  const busy = ["checking", "downloading", "installing"].includes(state.phase);
  button("check").disabled = busy;
  button("ui-check").disabled = busy;
  button("download").hidden = state.phase !== "available";
  button("install").hidden = state.phase !== "ready";
  button("release").hidden = !state.availableVersion;
  element("history").replaceChildren();
  if (!state.history.length) element("history").textContent = "暂无升级记录";
  for (const entry of state.history) {
    const row = document.createElement("div");
    row.className = "history-row";
    const version = document.createElement("span");
    version.textContent = `${entry.fromVersion} → ${entry.version}`;
    const result = document.createElement("span");
    result.textContent = `${entry.outcome === "installed" ? "已安装" : "未完成"} · ${new Date(entry.at).toLocaleDateString()}`;
    row.append(version, result);
    element("history").append(row);
  }
}
for (const action of [
  "check",
  "download",
  "install",
  "release",
  "ui-check",
] as UpdaterAction[]) {
  button(action).onclick = () => {
    void window.synaxUpdater
      .action(action)
      .then(render)
      .catch((error) => {
        element("message").textContent = String(error);
      });
  };
}
window.synaxUpdater.subscribe(render);
void window.synaxUpdater.state().then(render);
