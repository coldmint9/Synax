// Runs only inside an opaque-origin frame. No host API is forwarded into this world.
(() => {
  const node = document.getElementById("synax-visualization-config");
  const config = JSON.parse(node.textContent);
  node.remove();
  const parentWindow = window.parent;
  const send = parentWindow.postMessage.bind(parentWindow);
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const root = document.documentElement;
  const post = (type, extra = {}) =>
    send(
      {
        channel: "synax-visualization",
        id: config.id,
        token: config.token,
        type,
        ...extra,
      },
      "*",
    );
  const stateEvent = () =>
    window.dispatchEvent(
      new CustomEvent("openai:set_globals", {
        detail: { globals: window.openai },
      }),
    );
  const applyTheme = (theme) => {
    const value = theme === "dark" ? "dark" : "light";
    root.dataset.theme = value;
    root.style.colorScheme = value;
    window.openai.theme = value;
    window.openai.visualizationTheme = value;
    stateEvent();
  };
  window.openai = {
    theme: config.theme,
    visualizationTheme: config.theme,
    widgetState: null,
    statePersistence: "none",
    async setWidgetState(value) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new TypeError("State must be a JSON object");
      const json = stringify({
        modelContent: value.modelContent ?? null,
        privateContent: value.privateContent ?? null,
      });
      if (new TextEncoder().encode(json).length > 16384)
        throw new RangeError("State exceeds 16 KiB");
      window.openai.widgetState = parse(json);
      stateEvent();
    },
  };
  applyTheme(config.theme);
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (
      event.source === parentWindow &&
      data?.channel === "synax-visualization" &&
      data.id === config.id &&
      data.token === config.token &&
      data.type === "theme"
    )
      applyTheme(data.theme);
  });
  // Bundled Lucide SVGs; no icon download and no placeholder glyph substitutions.
  window.lucide = {
    createIcons(options = {}) {
      document.querySelectorAll("[data-lucide]").forEach((placeholder) => {
        const name = placeholder.getAttribute("data-lucide");
        const markup = Object.hasOwn(config.icons, name)
          ? config.icons[name]
          : null;
        if (!markup) {
          placeholder.hidden = true;
          return;
        }
        const template = document.createElement("template");
        template.innerHTML = markup;
        const svg = template.content.firstElementChild;
        for (const attr of placeholder.attributes) {
          if (
            ["class", "role", "id", "hidden"].includes(attr.name) ||
            attr.name.startsWith("aria-") ||
            (attr.name.startsWith("data-") && attr.name !== "data-lucide")
          )
            svg.setAttribute(attr.name, attr.value);
        }
        for (const key of ["width", "height", "stroke-width"]) {
          const value = Number(options.attrs?.[key]);
          if (Number.isFinite(value) && value > 0 && value < 128)
            svg.setAttribute(key, String(value));
        }
        svg.dataset.lucideIcon = name;
        placeholder.replaceWith(svg);
      });
    },
  };
  // Links and form submission are intentionally local; click handlers on controls still run.
  document.addEventListener(
    "click",
    (event) => {
      if (event.target instanceof Element && event.target.closest("a, area"))
        event.preventDefault();
    },
    true,
  );
  document.addEventListener("submit", (event) => event.preventDefault(), true);
  window.addEventListener("pagehide", () => post("exit"));
  window.addEventListener("error", (event) => {
    // Chromium defers ResizeObserver notifications during normal responsive reflow.
    // This is not an exception in the generated script and must not destroy the preview.
    if (
      !event.error &&
      [
        "ResizeObserver loop completed with undelivered notifications.",
        "ResizeObserver loop limit exceeded",
      ].includes(event.message)
    )
      return;
    post("error");
  });
  window.addEventListener("unhandledrejection", () => post("error"));
  let scheduled = false;
  let previousHeight = 0;
  const reportHeight = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const height = Math.ceil(
        Math.max(
          document.body.scrollHeight,
          document.body.getBoundingClientRect().height,
        ),
      );
      if (height !== previousHeight) {
        previousHeight = height;
        post("resize", { height });
      }
    });
  };
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      window.lucide.createIcons();
      // Opt-in shared tabs; product mockups keep their own interaction code.
      document
        .querySelectorAll('.nav-pills[role="tablist"]')
        .forEach((list) => {
          list.addEventListener("click", (event) => {
            const tab = event.target.closest('[role="tab"]');
            if (
              !tab ||
              tab.disabled ||
              tab.getAttribute("aria-disabled") === "true"
            )
              return;
            list.querySelectorAll('[role="tab"]').forEach((peer) => {
              const active = peer === tab;
              peer.classList.toggle("active", active);
              peer.setAttribute("aria-selected", String(active));
              const panel = document.getElementById(
                peer.getAttribute("aria-controls"),
              );
              if (panel) panel.hidden = !active;
            });
          });
        });
      new ResizeObserver(reportHeight).observe(document.body);
      post("ready");
      reportHeight();
    },
    { once: true },
  );
  window.addEventListener("load", reportHeight);
})();
