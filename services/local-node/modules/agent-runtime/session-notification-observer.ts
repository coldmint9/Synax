import {
  notificationKind,
  notificationMarker,
  quietSessionNotification,
  sessionNotificationPayload,
} from "../../../../packages/contracts/session-notifications.js";
import { logger } from "../../infrastructure/runtime/logger.js";
import { postParentMessage } from "../../infrastructure/runtime/parent-channel.js";
import { runtimeBus, type RuntimeBusEvent } from "./runtime-bus.js";
import { runtimeFacade } from "./sidecar/runtime-facade.js";

/** Wire messages the desktop parent reads; it owns OS delivery and the badge. */
export const SESSION_NOTIFICATION_MESSAGE = "synax:session-notification";
export const SESSION_NOTIFICATION_SETTINGS_MESSAGE = "synax:session-notifications";

export type SessionNotificationLocale = "zh" | "en";

export interface SessionNotificationDelivery {
  /**
   * True only while the desktop shell has no live renderer to notify: the
   * window is closed, loading or reloading. The renderer keeps ownership
   * otherwise so one transition never produces two notices.
   */
  desktop: boolean;
  locale: SessionNotificationLocale;
}

interface Observation {
  status: string;
  marker?: string;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Detects the transitions worth interrupting the user for and hands the desktop
 * parent a ready-to-show notice while no window can do it.
 *
 * Detection lives here, next to the session lifecycle, because this process is
 * the only writer that survives the window; the notice text comes from the
 * shared session-notification contract so both delivery paths agree.
 */
export class SessionNotificationObserver {
  private delivery: SessionNotificationDelivery = {
    desktop: false,
    locale: "zh",
  };
  private observations = new Map<string, Observation>();
  private resolving = new Set<string>();
  private queued = new Set<string>();
  private sequence = 0;
  private unsubscribe: (() => void) | null = null;

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = runtimeBus.subscribe((event) => this.observe(event));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.observations.clear();
    this.resolving.clear();
    this.queued.clear();
  }

  configure(patch: Partial<SessionNotificationDelivery>): void {
    this.delivery = {
      desktop: patch.desktop ?? this.delivery.desktop,
      locale:
        patch.locale === "zh" || patch.locale === "en"
          ? patch.locale
          : this.delivery.locale,
    };
  }

  deliverySettings(): SessionNotificationDelivery {
    return { ...this.delivery };
  }

  private observe(event: RuntimeBusEvent): void {
    if (event.type !== "session_changed") return;
    const status = event.patch?.status;
    if (typeof status !== "string") return;
    const marker = notificationMarker(status, event.patch ?? {});
    const previous = this.observations.get(event.sessionId);
    if (
      previous?.status === status &&
      (!marker || marker === previous.marker)
    )
      return;
    // Every transition is remembered, including while this process is not
    // delivering: handing delivery over must never replay an episode the
    // window already showed.
    this.observations.delete(event.sessionId);
    this.observations.set(event.sessionId, { status, marker });
    if (this.observations.size > 512)
      this.observations.delete(this.observations.keys().next().value!);
    if (!this.delivery.desktop) return;
    if (!notificationKind(status)) return;
    // A transition that lands while this session's lookup is in flight must
    // still be delivered: the newest episode wins, it is never dropped.
    if (this.resolving.has(event.sessionId)) {
      this.queued.add(event.sessionId);
      return;
    }
    this.resolving.add(event.sessionId);
    void this.deliverLatest(event.sessionId)
      .catch((error) =>
        logger.warn(
          { sessionId: event.sessionId, error: describe(error) },
          "Session notification lookup failed",
        ),
      )
      .finally(() => this.resolving.delete(event.sessionId));
  }

  private async deliverLatest(sessionId: string): Promise<void> {
    do {
      this.queued.delete(sessionId);
      await this.deliverCurrent(sessionId);
    } while (this.queued.delete(sessionId) && this.delivery.desktop);
  }

  private async deliverCurrent(sessionId: string): Promise<void> {
    const observed = this.observations.get(sessionId);
    if (!observed || !this.delivery.desktop) return;
    const kind = notificationKind(observed.status);
    if (!kind) return;
    // The worker may own the session: only the authoritative snapshot can tell
    // whether this transition really settled, and with what summary.
    const session = await runtimeFacade.sessionSummaryAuthoritative(sessionId);
    if (!this.delivery.desktop || !session || session.id !== sessionId) return;
    // A newer transition replaced this episode while the snapshot loaded; the
    // queued pass delivers that one instead.
    if (
      this.observations.get(sessionId)?.status !== observed.status ||
      session.status !== observed.status
    )
      return;
    if (quietSessionNotification(session, kind)) return;
    postParentMessage({
      type: SESSION_NOTIFICATION_MESSAGE,
      payload: sessionNotificationPayload(
        session,
        kind,
        this.delivery.locale,
        ++this.sequence,
      ),
    });
  }
}

export const sessionNotificationObserver = new SessionNotificationObserver();
