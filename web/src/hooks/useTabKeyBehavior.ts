import { useEffect } from "react";

/** Four-space indent inserted by the Tab key inside editable elements. */
const INDENT = "    ";

/** Input types that carry plain text (other types never hold a text cursor). */
const TEXT_INPUT_TYPES = new Set([
  "text",
  "email",
  "password",
  "search",
  "tel",
  "url",
]);

function isEditable(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return target.type === "" || TEXT_INPUT_TYPES.has(target.type);
  }
  return false;
}

function insertIndent(el: HTMLElement): void {
  // execCommand keeps native undo history and emits a real input event for React.
  try {
    if (
      typeof document.execCommand === "function" &&
      document.execCommand("insertText", false, INDENT)
    ) {
      return;
    }
  } catch {
    // Fall through to manual insertion.
  }
  if (
    !(el instanceof HTMLTextAreaElement) &&
    !(el instanceof HTMLInputElement)
  ) {
    return;
  }
  const value = el.value;
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? start;
  const next = `${value.slice(0, start)}${INDENT}${value.slice(end)}`;
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setValue) setValue.call(el, next);
  else el.value = next;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  const caret = start + INDENT.length;
  try {
    el.setSelectionRange?.(caret, caret);
  } catch {
    // Non-text input types reject selection APIs.
  }
}

/**
 * Tab never moves focus between elements in Synax. Inside editable elements
 * (text inputs, textareas, contentEditable) it inserts a four-space indent
 * instead. The xterm helper textarea keeps native shell Tab completion.
 */
export function useTabKeyBehavior(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.isComposing || event.keyCode === 229) return;
      const target = event.target;
      // Terminal pane: Tab belongs to the shell (completion).
      if (target instanceof Element && target.closest(".xterm")) return;
      // Stop Tab focus navigation everywhere, including dialog focus traps.
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey || !isEditable(target)) return;
      insertIndent(target);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
