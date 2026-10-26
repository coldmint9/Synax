import { useEffect } from "react";
import {
  useNotificationStore,
  type NotificationType,
} from "../state/notificationStore";
import { errorNotificationId } from "../lib/errors";

const ERROR_SELECTOR = '[role="alert"], [data-error], [class*="error"], [class*="Error"]';
const TOAST_SOURCE_ATTRIBUTE = "data-synax-error-toast-source";
/** Tool rows state their own outcome inline, including failures and denials. */
const TOOL_ROW_ATTRIBUTE = "[data-tool-status]";
/** 组件声明"这里的错误我在原地展示"，桥接既不提升也不隐藏它。 */
const OPT_OUT_ATTRIBUTE = "data-error-toast";
/** 显式指定浮层色调，缺省按 class 里的 warning 语义推断。 */
const TONE_ATTRIBUTE = "data-error-toast-tone";
const WARNING_HINT = /(?:^|\s)(?:text|border|bg|ring)-warning(?:\/\d+)?(?:\s|$)/;

function isSuppressed(element: HTMLElement): boolean {
  return element.closest(`[${OPT_OUT_ATTRIBUTE}="off"]`) !== null;
}

function toneFor(element: HTMLElement): NotificationType {
  const explicit = element
    .closest<HTMLElement>(`[${TONE_ATTRIBUTE}]`)
    ?.getAttribute(TONE_ATTRIBUTE);
  if (explicit === "warning" || explicit === "info") return explicit;
  return WARNING_HINT.test(element.getAttribute("class") ?? "")
    ? "warning"
    : "error";
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function getMessage(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("button").forEach((button) => button.remove());
  return normalizeText(copy.textContent ?? "");
}

function getActions(element: HTMLElement) {
  return Array.from(element.querySelectorAll<HTMLButtonElement>("button"))
    .map((button) => ({
      label: normalizeText(button.textContent || button.getAttribute("aria-label") || ""),
      onClick: () => button.click(),
    }))
    .filter((action) => action.label)
    .slice(0, 3);
}

function hideSource(element: HTMLElement): void {
  element.setAttribute(TOAST_SOURCE_ATTRIBUTE, "true");
  element.setAttribute("aria-hidden", "true");
  element.style.setProperty("display", "none", "important");
}

function promote(element: HTMLElement, processed: WeakMap<HTMLElement, string>): void {
  if (
    isSuppressed(element) ||
    element.hasAttribute(TOAST_SOURCE_ATTRIBUTE) ||
    element.closest("[data-synax-toast]") ||
    // A failed or denied tool call is transcript content the model works with,
    // not an application error, so a tool row never becomes a toast.
    element.closest(TOOL_ROW_ATTRIBUTE) ||
    element.parentElement?.closest(ERROR_SELECTOR)
  ) {
    return;
  }

  const message = getMessage(element);
  if (!message || processed.get(element) === message) return;

  processed.set(element, message);
  const actions = getActions(element);
  hideSource(element);
  useNotificationStore.getState().pushAggregated({
    id: errorNotificationId(message),
    type: toneFor(element),
    message,
    actions: actions.length > 0 ? actions : undefined,
    duration: actions.length > 0 ? 0 : 5000,
  });
}

function scan(root: ParentNode, processed: WeakMap<HTMLElement, string>): void {
  const direct = root instanceof HTMLElement && root.matches(ERROR_SELECTOR);
  if (direct) {
    promote(root, processed);
  }
  if (!direct && !root.querySelector(ERROR_SELECTOR)) return;
  root.querySelectorAll<HTMLElement>(ERROR_SELECTOR).forEach((element) => {
    promote(element, processed);
  });
}

/**
 * Promotes component-level alert regions to the shared top toast stack.
 * Components keep their local error state for retries and control flow, while
 * the user sees one consistent notification surface for every error message.
 */
export function ErrorToastBridge() {
  useEffect(() => {
    const processed = new WeakMap<HTMLElement, string>();
    scan(document.body, processed);

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "childList") {
          record.addedNodes.forEach((node) => {
            if (node instanceof HTMLElement) scan(node, processed);
          });
        }
        const target = record.target instanceof HTMLElement
          ? record.target.closest<HTMLElement>(ERROR_SELECTOR)
          : null;
        if (target) promote(target, processed);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
