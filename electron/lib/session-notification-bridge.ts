/**
 * Routes session notices between the runtime process and the desktop shell.
 *
 * The renderer owns notices while it is alive. When the window is gone (macOS
 * keeps the app running) or reloading, that ownership passes to the runtime,
 * which detects the transition and publishes a ready-to-show payload. This
 * bridge is the only place that decides which side currently owns delivery, so
 * one settled session can never produce two banners or two Dock increments.
 */
export const SESSION_NOTIFICATION_MESSAGE = "synax:session-notification";
export const SESSION_NOTIFICATION_SETTINGS_MESSAGE = "synax:session-notifications";

export type NotificationLocale = "zh" | "en";

export interface NotificationDeliverySettings {
  enabled: boolean;
  locale: NotificationLocale;
  rendererReady: boolean;
}

/** The desktop surface that actually shows a notice and updates the badge. */
export interface SessionNotificationSink {
  show(payload: unknown): boolean;
}

const normalizeLocale = (value: unknown): NotificationLocale | undefined =>
  value === "zh" || value === "en" ? value : undefined;

export class SessionNotificationBridge {
  private settings: NotificationDeliverySettings = {
    // Mirrors the notification service: nothing is delivered until the user's
    // preference has been read from the renderer.
    enabled: false,
    locale: "zh",
    rendererReady: false,
  };

  constructor(
    private readonly send: (message: unknown) => boolean,
    private readonly sink: SessionNotificationSink,
  ) {}

  configure(patch: {
    enabled?: boolean;
    locale?: unknown;
    rendererReady?: boolean;
  }): void {
    this.settings = {
      enabled:
        typeof patch.enabled === "boolean" ? patch.enabled : this.settings.enabled,
      locale: normalizeLocale(patch.locale) ?? this.settings.locale,
      rendererReady:
        typeof patch.rendererReady === "boolean"
          ? patch.rendererReady
          : this.settings.rendererReady,
    };
    this.publish();
  }

  /** The runtime must re-learn delivery ownership after every restart. */
  publish(): void {
    this.send({
      type: SESSION_NOTIFICATION_SETTINGS_MESSAGE,
      desktop: this.backgroundOwned,
      locale: this.settings.locale,
    });
  }

  /** True while no live renderer can show the notice itself. */
  private get backgroundOwned(): boolean {
    return this.settings.enabled && !this.settings.rendererReady;
  }

  /**
   * Accepts runtime notices only while the runtime owns delivery; a message
   * already in flight when the window comes back must not double-notify.
   */
  receive(message: unknown): boolean {
    if (!message || typeof message !== "object" || !this.backgroundOwned)
      return false;
    const { type, payload } = message as { type?: unknown; payload?: unknown };
    // Content validation belongs to the notification service; this only keeps
    // unrelated traffic off its path.
    if (type !== SESSION_NOTIFICATION_MESSAGE || !payload || typeof payload !== "object")
      return false;
    return this.sink.show(payload);
  }
}
