/* global window, document, PerformanceObserver, requestAnimationFrame, MutationObserver, TextDecoder */
/**
 * Injected into every measured page before the app boots (benchmark fixture).
 *
 * Cheap by design: the probe must not change what it measures. It never scans
 * the transcript; it looks at the streaming tail node at most once per frame.
 * All timestamps are wall-clock (`Date.now()`), so they share a timeline with
 * the server's ISO run records and the provider stub on the same machine.
 */
(() => {
  const state = {
    armed: false,
    sendAt: 0,
    submitAt: 0,
    generatingAt: 0,
    deltaAt: 0,
    mutationAt: 0,
    paintAt: 0,
    firstText: '',
  };
  window.__bench = state;
  let baselineCount = 0;
  let baselineLength = 0;
  /** Assistant nodes that already existed when the send was armed. */
  let baselineNodes = new Set();
  let scheduled = false;

  const textTail = () => {
    const tail = document.querySelector('.markdown-stream-tail, .markdown-stream-pending');
    // A tail left over from the previous turn is not this send's first character.
    if (tail && !baselineNodes.has(tail)) {
      const text = (tail.textContent || '').trim();
      if (text.length) return { text };
    }
    const nodes = document.querySelectorAll('.agent-conversation-copy:not(.session-user-message)');
    const last = nodes.length ? nodes[nodes.length - 1] : null;
    if (!last || baselineNodes.has(last)) return null;
    const text = (last.textContent || '').trim();
    if (text.length) return { text };
    return null;
  };

  state.arm = () => {
    const nodes = document.querySelectorAll('.agent-conversation-copy:not(.session-user-message)');
    const last = nodes.length ? nodes[nodes.length - 1] : null;
    baselineCount = nodes.length;
    baselineLength = last ? (last.textContent || '').trim().length : 0;
    baselineNodes = new Set(nodes);
    state.armed = true;
    state.sendAt = 0;
    state.submitAt = 0;
    state.generatingAt = 0;
    state.deltaAt = 0;
    state.mutationAt = 0;
    state.paintAt = 0;
    state.firstText = '';
  };

  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name.indexOf('/runs') < 0 || state.submitAt) continue;
      // performance.now() belongs to the page origin; wall time joins the
      // server's ISO timestamps to the same timeline.
      state.submitAt = performance.timeOrigin + entry.startTime;
    }
  }).observe({ type: 'resource', buffered: false });

  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter' && state.armed && !state.sendAt) state.sendAt = Date.now();
    },
    true,
  );

  const check = () => {
    scheduled = false;
    if (!state.armed || state.paintAt) return;
    const hit = textTail();
    if (!hit) return;
    state.mutationAt = Date.now();
    state.firstText = hit.text.slice(0, 40);
    requestAnimationFrame(() => {
      if (!state.paintAt) state.paintAt = Date.now();
    });
  };
  const schedule = () => {
    if (scheduled || state.paintAt) return;
    scheduled = true;
    requestAnimationFrame(check);
  };
  const attach = () => {
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  };
  if (document.documentElement) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });

  // Same-origin observation stream: when the first token / delta reaches this
  // browser. `after` skips everything the previous measured send produced.
  state.watchStream = (sessionId, after) => {
    void (async () => {
      const response = await fetch(
        '/api/agent-runtime/sessions/' + sessionId + '/stream?after=' + (after || 0),
      );
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        pending += decoder.decode(next.value, { stream: true });
        for (;;) {
          const index = pending.indexOf('\n\n');
          if (index < 0) break;
          const frame = pending.slice(0, index);
          pending = pending.slice(index + 2);
          // Frames that arrive before the keydown are replay from an earlier
          // run; they must never timestamp this send.
          if (!state.sendAt) continue;
          if (!state.generatingAt && frame.indexOf('"generating"') >= 0)
            state.generatingAt = Date.now();
          if (!state.deltaAt && frame.indexOf('"message_delta"') >= 0) state.deltaAt = Date.now();
          if (state.deltaAt) {
            void reader.cancel().catch(() => undefined);
            return;
          }
        }
      }
    })().catch(() => undefined);
  };
})();
