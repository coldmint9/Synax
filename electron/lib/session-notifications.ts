import {
  Notification,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";

export type SessionNotificationKind =
  | "completed"
  | "input"
  | "approval"
  | "failed";
export interface SessionNotificationTarget {
  projectId: string;
  sessionId: string;
  kind: SessionNotificationKind;
}
interface SessionNotification extends SessionNotificationTarget {
  id: string;
  title: string;
  body: string;
}
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
function parseNotification(value: unknown): SessionNotification | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (
    !identifier(item.projectId) ||
    !identifier(item.sessionId) ||
    typeof item.id !== "string" ||
    !item.id ||
    item.id.length > 512 ||
    !["completed", "input", "approval", "failed"].includes(String(item.kind)) ||
    typeof item.title !== "string" ||
    !item.title.trim() ||
    typeof item.body !== "string"
  )
    return null;
  // OS notifications are plain text, never renderer-provided navigation or actions.
  const clean = (text: string, limit: number) =>
    Array.from(text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""))
      .slice(0, limit)
      .join("");
  return {
    id: item.id,
    projectId: item.projectId,
    sessionId: item.sessionId,
    kind: item.kind as SessionNotificationKind,
    title: clean(item.title, 120),
    body: clean(item.body, 360),
  };
}

export function isTrustedNotificationSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
  window: BrowserWindow | null,
  isDev: boolean,
  webPort: string,
): boolean {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    return false;
  const url = event.senderFrame?.url ?? "";
  if (url.startsWith("app://./")) return true;
  try {
    return isDev && new URL(url).origin === `http://localhost:${webPort}`;
  } catch {
    return false;
  }
}

/** Main-process delivery owns focus policy, deduplication and click activation. */
export class SessionNotifications {
  private enabled = false;
  private rendererReady = false;
  private seen = new Set<string>();
  private active = new Map<string, Notification>();
  private pending: SessionNotificationTarget | null = null;

  constructor(
    private getWindow: () => BrowserWindow | null,
    private ensureWindow: () => Promise<BrowserWindow | null>,
    private icon: string,
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.pending = null;
      for (const sessionId of this.active.keys()) this.dismiss(sessionId);
    }
  }

  setRendererReady(ready: boolean): void {
    this.rendererReady = ready;
    if (ready) this.deliverPending();
  }

  dismiss(sessionId: string): void {
    const notification = this.active.get(sessionId);
    this.active.delete(sessionId);
    notification?.close();
  }

  show(value: unknown): boolean {
    const payload = parseNotification(value);
    const window = this.getWindow();
    if (
      !payload ||
      !this.enabled ||
      !Notification.isSupported() ||
      this.seen.has(payload.id) ||
      !window ||
      window.isDestroyed()
    )
      return false;
    // visibilityState alone is insufficient: a visible Electron window may be behind another app.
    if (window.isFocused() && window.isVisible() && !window.isMinimized())
      return false;
    this.dismiss(payload.sessionId);
    try {
      const notification = new Notification({
        title: payload.title,
        body: payload.body,
        icon: this.icon,
      });
      const target: SessionNotificationTarget = {
        projectId: payload.projectId,
        sessionId: payload.sessionId,
        kind: payload.kind,
      };
      const remove = () => {
        if (this.active.get(payload.sessionId) === notification)
          this.active.delete(payload.sessionId);
      };
      notification.on("click", () => {
        if (
          !this.enabled ||
          this.active.get(payload.sessionId) !== notification
        )
          return;
        void this.activate(target).catch(() => {
          console.warn("[notifications] Could not activate the session window");
        });
      });
      notification.on("close", remove);
      notification.on("failed", () => {
        remove();
        this.seen.delete(payload.id);
        console.warn("[notifications] Native notification delivery failed");
      });
      this.active.set(payload.sessionId, notification);
      this.seen.add(payload.id);
      if (this.seen.size > 512)
        this.seen.delete(this.seen.values().next().value!);
      notification.show();
      // Bound retained OS notification objects as well as dedupe keys.
      if (this.active.size > 64) this.dismiss(this.active.keys().next().value!);
      return true;
    } catch {
      this.active.delete(payload.sessionId);
      this.seen.delete(payload.id);
      console.warn("[notifications] Native notification unavailable");
      return false;
    }
  }

  private async activate(target: SessionNotificationTarget): Promise<void> {
    this.pending = target;
    let window = this.getWindow();
    if (!window || window.isDestroyed()) window = await this.ensureWindow();
    if (!this.enabled || !window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    this.deliverPending();
  }

  private deliverPending(): void {
    const window = this.getWindow();
    if (
      !this.pending ||
      !this.rendererReady ||
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    )
      return;
    window.webContents.send("notifications:open-session", this.pending);
    this.pending = null;
  }

  dispose(): void {
    this.setEnabled(false);
    this.rendererReady = false;
    this.seen.clear();
  }
}
