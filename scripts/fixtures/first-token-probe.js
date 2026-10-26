/* global window, document, PerformanceObserver, requestAnimationFrame, MutationObserver, CSS */
/** Measures the app's actual run stream and a DOM node owned by that step. */
(() => {
  const state = { armed: false, sessionId: '', runId: '', stepId: '', sendAt: 0, submitAt: 0,
    generatingAt: 0, deltaAt: 0, mutationAt: 0, paintAt: 0, firstText: '',
    providerFirstTokenAt: 0, rustFirstTokenAt: 0, nodeFirstTokenAt: 0,
    realtimeEnqueueAt: 0, clientReceivedAt: 0, clientPaintAt: 0, completedAt: 0 };
  window.__bench = state;
  let scheduled = false;
  let generation = 0;
  const pendingTokens = new Map();
  state.arm = (sessionId) => {
    generation++;
    pendingTokens.clear();
    Object.assign(state, { armed: true, sessionId, runId: '', stepId: '', sendAt: 0, submitAt: 0,
      generatingAt: 0, deltaAt: 0, mutationAt: 0, paintAt: 0, firstText: '',
      providerFirstTokenAt: 0, rustFirstTokenAt: 0, nodeFirstTokenAt: 0,
      realtimeEnqueueAt: 0, clientReceivedAt: 0, clientPaintAt: 0, completedAt: 0 });
  };
  new PerformanceObserver(list => {
    if (!state.armed || !state.sendAt) return;
    for (const entry of list.getEntries()) {
      if (!entry.name.endsWith('/runs') || state.submitAt) continue;
      const at = performance.timeOrigin + entry.startTime;
      if (at >= state.sendAt) state.submitAt = at;
    }
  }).observe({ type: 'resource', buffered: false });
  window.addEventListener('keydown', event => {
    if (event.key === 'Enter' && state.armed && !state.sendAt) state.sendAt = Date.now();
  }, true);
  window.addEventListener('synax:run-accepted', event => {
    if (state.armed && state.sendAt && event.detail.sessionId === state.sessionId) {
      state.runId = event.detail.runId;
      const token = pendingTokens.get(state.runId);
      if (token) receive(token);
      pendingTokens.clear();
    }
  });
  window.addEventListener('synax:run-complete', event => {
    if (state.armed && event.detail.sessionId === state.sessionId && event.detail.runId === state.runId)
      state.completedAt = Date.now();
  });
  function receive(data) {
    if (!state.armed || !state.sendAt || data.sessionId !== state.sessionId || data.runId !== state.runId || state.deltaAt) return;
    Object.assign(state, { stepId: data.stepId, deltaAt: data.clientReceivedAt,
      generatingAt: data.nodeFirstTokenAt || data.clientReceivedAt,
      providerFirstTokenAt: data.providerFirstTokenAt || 0, rustFirstTokenAt: data.rustFirstTokenAt || 0,
      nodeFirstTokenAt: data.nodeFirstTokenAt || 0, realtimeEnqueueAt: data.realtimeEnqueueAt || 0,
      clientReceivedAt: data.clientReceivedAt });
    schedule();
  }
  window.addEventListener('synax:first-token', event => {
    const data = event.detail;
    if (state.armed && state.sendAt && data.sessionId === state.sessionId && !state.runId) {
      if (!pendingTokens.has(data.runId)) pendingTokens.set(data.runId, data);
      return;
    }
    receive(data);
  });
  const check = () => {
    scheduled = false;
    if (!state.armed || !state.deltaAt || !state.stepId || state.paintAt) return;
    const node = document.querySelector('[data-stream-text-step="' + CSS.escape(state.stepId) + '"]');
    const text = node && (node.textContent || '').trim();
    if (!text) return;
    const current = generation;
    state.mutationAt = Date.now();
    state.firstText = text.slice(0, 40);
    requestAnimationFrame(() => {
      if (current === generation && !state.paintAt) state.clientPaintAt = state.paintAt = Date.now();
    });
  };
  const schedule = () => {
    if (scheduled || state.paintAt || !state.deltaAt) return;
    scheduled = true;
    requestAnimationFrame(check);
  };
  const attach = () => new MutationObserver(schedule).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true,
  });
  if (document.documentElement) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });
})();
