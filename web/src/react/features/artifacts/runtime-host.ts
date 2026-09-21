import type {
  ArtifactControl,
  ArtifactState,
} from "../../../../../api/services/agent-runtime/artifacts/contracts";
import { artifactsApi } from "../../../lib/api/artifacts";
import {
  feedbackInput,
  safeJson,
  validateControls,
  validateControlValue,
  type FeedbackDraft,
} from "./bridge";

/** One controller per revision/mount: never writes restored state to a new revision. */
export class ArtifactRuntimeHost {
  state: ArtifactState;
  controls: ArtifactControl[] = [];
  logs: Array<{ level: string; message: string }> = [];
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private savePromise: Promise<void> | undefined;
  private dirty = false;
  private failed = false;
  private waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  constructor(
    private options: {
      sessionId: string;
      revisionId: string;
      state: ArtifactState;
      onState: (state: ArtifactState) => void;
      onSaving?: (saving: boolean) => void;
      onControls: (controls: ArtifactControl[]) => void;
      onDraft: (draft: FeedbackDraft) => void;
      onHeight: (height: number) => void;
      onLog?: (logs: Array<{ level: string; message: string }>) => void;
      onError: (message: string) => void;
      send: (type: string, payload: unknown) => void;
    },
  ) {
    this.state = safeJson(options.state, 16384);
  }
  async handle(type: string, payload: unknown): Promise<unknown> {
    if (this.disposed) throw new Error("Preview has stopped.");
    switch (type) {
      case "ready":
        return {
          theme:
            document.documentElement.classList.contains("dark") ||
            document.documentElement.dataset.theme === "dark"
              ? "dark"
              : "light",
          locale: document.documentElement.lang || navigator.language,
          state: this.state,
        };
      case "state": {
        const next = safeJson(payload, 16384);
        if (
          !next ||
          typeof next !== "object" ||
          Array.isArray(next) ||
          Object.keys(next).some(
            (k) => !["privateState", "modelState"].includes(k),
          )
        )
          throw new Error("Only privateState and modelState may be changed.");
        await this.change({ ...this.state, ...next });
        return this.state;
      }
      case "controls": {
        const controls = validateControls(payload);
        const values: Record<string, unknown> = {};
        for (const c of controls)
          values[c.key] = validateControlValue(c, this.state.controls[c.key])
            ? this.state.controls[c.key]
            : c.defaultValue;
        this.controls = controls;
        this.options.onControls(controls);
        await this.change({ ...this.state, controls: values });
        return this.state.controls;
      }
      case "feedbackDraft": {
        const input = safeJson(payload, 16384);
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw new Error("Invalid feedback draft.");
        const draft = input as FeedbackDraft;
        const checked = feedbackInput(draft, this.state, "draft");
        this.options.onDraft({
          text: checked.text,
          modelState: checked.modelState,
        });
        return null;
      }
      case "element": {
        const checked = feedbackInput(
          { element: payload as FeedbackDraft["element"] },
          this.state,
          "draft",
        );
        this.options.onDraft({ element: checked.element });
        return null;
      }
      case "log": {
        const entry = safeJson(payload, 2048) as {
          level: string;
          message: string;
        };
        if (
          !entry ||
          !["log", "info", "warn", "error"].includes(entry.level) ||
          typeof entry.message !== "string"
        )
          throw new Error("Invalid log entry.");
        this.logs = [
          ...this.logs,
          { level: entry.level, message: entry.message },
        ].slice(-100);
        this.options.onLog?.(this.logs);
        return null;
      }
      case "resize": {
        const height = (payload as { height?: unknown })?.height;
        if (typeof height !== "number" || !Number.isFinite(height))
          throw new Error("Invalid preview height.");
        this.options.onHeight(Math.max(96, Math.min(640, Math.round(height))));
        return null;
      }
      default:
        throw new Error("Unsupported artifact request.");
    }
  }
  async setControl(control: ArtifactControl, value: unknown) {
    if (
      !this.controls.some((c) => c.key === control.key) ||
      !validateControlValue(control, value)
    )
      throw new Error("Invalid control value.");
    const saving = this.change({
      ...this.state,
      controls: { ...this.state.controls, [control.key]: value },
    });
    this.options.send("controlsChanged", this.state.controls);
    await saving;
  }
  reset() {
    return this.change({
      ...this.state,
      privateState: null,
      modelState: null,
      controls: Object.fromEntries(
        this.controls.map((c) => [c.key, c.defaultValue]),
      ),
    }).then(() => {
      this.options.send("stateChanged", this.state);
      this.options.send("controlsChanged", this.state.controls);
    });
  }
  private async change(next: ArtifactState): Promise<void> {
    if (this.disposed || this.failed)
      return Promise.reject(
        new Error(
          "State is not writable. Reload saved state before continuing.",
        ),
      );
    this.state = safeJson(next, 16384);
    this.dirty = true;
    this.options.onSaving?.(true);
    this.options.onState(this.state);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 500);
    return new Promise((resolve, reject) =>
      this.waiters.push({ resolve, reject }),
    );
  }
  flush(): Promise<void> {
    if (this.savePromise)
      return this.savePromise.then(() =>
        this.dirty ? this.flush() : undefined,
      );
    if (!this.dirty || this.disposed || this.failed) return Promise.resolve();
    if (this.timer) clearTimeout(this.timer);
    this.dirty = false;
    const snapshot = this.state;
    const waiting = this.waiters.splice(0);
    this.savePromise = (async () => {
      try {
        const saved = await artifactsApi.saveState(
          this.options.sessionId,
          this.options.revisionId,
          snapshot,
        );
        if (this.disposed) {
          waiting.forEach((w) => w.reject(new Error("Preview stopped.")));
          return;
        }
        this.state = this.dirty
          ? { ...this.state, etag: saved.etag }
          : safeJson(saved, 16384);
        this.options.onState(this.state);
        waiting.forEach((w) => w.resolve());
      } catch (error) {
        this.failed = true;
        this.dirty = false;
        waiting.concat(this.waiters.splice(0)).forEach((w) => w.reject(error));
        if (!this.disposed)
          this.options.onError(
            `State could not be saved. Reload saved state before continuing. ${error instanceof Error ? error.message : ""}`,
          );
      } finally {
        this.savePromise = undefined;
        if (!this.dirty) this.options.onSaving?.(false);
      }
    })();
    return this.savePromise.then(() => (this.dirty ? this.flush() : undefined));
  }
  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.waiters
      .splice(0)
      .forEach((w) =>
        w.reject(new Error("Preview stopped before state was saved.")),
      );
  }
}
