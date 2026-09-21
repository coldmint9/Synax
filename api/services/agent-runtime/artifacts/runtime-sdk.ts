/** Static browser bootstrap. Stored as source text intentionally: Function.toString()
 * is unsafe here because tsx/esbuild may inject out-of-scope helpers such as __name.
 * Compiler hashes this exact script; host injects only an inert head meta BEFORE it.
 * No meta means standalone local state. Never add Node or privileged host APIs. */
export function artifactSdkSource(): string {
  return String.raw`(function bootstrap() {
    const w = window;
    const meta = document.querySelector('meta[name="synax-artifact-runtime"]');
    let config = null;
    try {
        config = JSON.parse(meta?.getAttribute('content') || 'null');
    }
    catch { /* standalone */ }
    meta?.remove();
    if (config && (config.protocol !== 1 || !['instanceId', 'revisionId', 'nonce'].every(k => typeof config[k] === 'string' && config[k].length > 0)))
        config = null;
    const standalone = !config;
    let state = { privateState: null, modelState: null, controls: {}, schemaVersion: 1, etag: 0 };
    let theme = 'light';
    let locale = navigator.language || 'en';
    let port = null;
    let connected = false;
    let serial = 0;
    let picking = false;
    const pending = new Map();
    const listeners = { theme: new Set(), state: new Set(), controls: new Set() };
    let connectResolve;
    let connectReject;
    const connection = new Promise((resolve, reject) => { connectResolve = resolve; connectReject = reject; });
    // Attach a handler immediately; a preview can be loaded without calling ready().
    void connection.catch(() => { });
    const connectTimer = standalone ? null : setTimeout(() => connectReject(new Error('Artifact host connection timed out.')), 5000);
    function json(value, limit = 32768) {
        const seen = new Set();
        let nodes = 0;
        function walk(v, depth) {
            if (++nodes > 4096 || depth > 24)
                throw new Error('Artifact data nesting limit exceeded.');
            if (v === null || typeof v === 'string' || typeof v === 'boolean')
                return;
            if (typeof v === 'number' && Number.isFinite(v))
                return;
            if (typeof v !== 'object' || seen.has(v))
                throw new Error('Artifact state must be acyclic JSON.');
            if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
                throw new Error('Artifact state must be plain JSON.');
            seen.add(v);
            for (const k of Object.keys(v)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k))
                    throw new Error('Unsafe state key.');
                walk(v[k], depth + 1);
            }
            seen.delete(v);
        }
        walk(value, 0);
        const text = JSON.stringify(value);
        if (new TextEncoder().encode(text).length > limit)
            throw new Error('Artifact data limit exceeded.');
        return JSON.parse(text);
    }
    function validateControls(schema) {
        json(schema, 16384);
        if (!Array.isArray(schema) || schema.length > 12) throw new Error('At most 12 controls are allowed.');
        const keys = new Set();
        for (const c of schema) {
            if (!c || typeof c.key !== 'string' || !/^[a-zA-Z][\w-]{0,63}$/.test(c.key) || ['__proto__','constructor','prototype'].includes(c.key) || keys.has(c.key) || typeof c.label !== 'string' || !c.label.trim() || c.label.length > 120 || !['select','toggle','range','number','color','text'].includes(c.type)) throw new Error('Invalid artifact control.');
            keys.add(c.key);
            for (const key of ['min','max','step']) if (c[key] !== undefined && (typeof c[key] !== 'number' || !Number.isFinite(c[key]))) throw new Error('Invalid control bounds.');
            if ((c.min !== undefined && c.max !== undefined && c.min > c.max) || (c.step !== undefined && c.step <= 0)) throw new Error('Invalid control range.');
            if (c.type === 'select' && (!Array.isArray(c.options) || c.options.length < 1 || c.options.length > 50 || c.options.some(o => !o || typeof o.label !== 'string' || o.label.length > 120 || typeof o.value !== 'string' || o.value.length > 2000))) throw new Error('Invalid control options.');
            const v = c.defaultValue;
            const valid = c.type === 'toggle' ? typeof v === 'boolean' : c.type === 'number' || c.type === 'range' ? typeof v === 'number' && Number.isFinite(v) && (c.min === undefined || v >= c.min) && (c.max === undefined || v <= c.max) : typeof v === 'string' && v.length <= 2000 && (c.type !== 'color' || /^#[\da-f]{6}$/i.test(v)) && (c.type !== 'select' || c.options.some(o => o.value === v));
            if (!valid) throw new Error('Invalid control default.');
        }
    }
    function envelope(type, payload, requestId) {
        return { ...config, type, ...(payload === undefined ? {} : { payload }), ...(requestId ? { requestId } : {}) };
    }
    function send(message) {
        json(message);
        if (config?.transport === 'desktop')
            window.postMessage(message, '*');
        else
            port?.postMessage(message);
    }
    async function request(type, payload = {}) {
        if (standalone)
            return null;
        await connection;
        const id = String(++serial);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { pending.delete(id); reject(new Error('Artifact host request timed out.')); }, 5000);
            pending.set(id, { resolve, reject, timer });
            try {
                send(envelope(type, payload, id));
            }
            catch (error) {
                clearTimeout(timer);
                pending.delete(id);
                reject(error);
            }
        });
    }
    function emit(kind, value) { for (const listener of listeners[kind]) {
        try {
            listener(json(value));
        }
        catch { /* isolate user callbacks */ }
    } }
    function applyTheme(value) {
        theme = value === 'dark' ? 'dark' : 'light';
        document.documentElement.dataset.synaxTheme = theme;
        document.documentElement.style.colorScheme = theme;
        const dark = theme === 'dark';
        for (const [key, val] of Object.entries({ '--synax-bg': dark ? '#18181b' : '#ffffff', '--synax-fg': dark ? '#f4f4f5' : '#18181b', '--synax-muted': dark ? '#a1a1aa' : '#71717a', '--synax-border': dark ? '#3f3f46' : '#e4e4e7', '--synax-accent': '#7c3aed' }))
            document.documentElement.style.setProperty(key, val);
        emit('theme', theme);
    }
    function accept(message) {
        try {
            json(message);
        }
        catch {
            return;
        }
        if (!message || message.protocol !== 1 || message.instanceId !== config?.instanceId || message.nonce !== config?.nonce || message.revisionId !== config?.revisionId)
            return;
        if (message.type === 'response' && typeof message.requestId === 'string') {
            const waiting = pending.get(message.requestId);
            if (!waiting)
                return;
            clearTimeout(waiting.timer);
            pending.delete(message.requestId);
            if (typeof message.payload?.error === 'string')
                waiting.reject(new Error(message.payload.error));
            else
                waiting.resolve(message.payload?.result);
        }
        else if (message.type === 'theme')
            applyTheme(message.payload?.theme);
        else if (message.type === 'stateChanged') {
            state = json(message.payload, 16384);
            emit('state', state);
        }
        else if (message.type === 'controlsChanged') {
            state.controls = json(message.payload, 16384);
            emit('controls', state.controls);
        }
        else if (message.type === 'pick') {
            picking = message.payload?.enabled === true;
            document.documentElement.style.cursor = picking ? 'crosshair' : '';
        }
    }
    function onWindow(event) {
        const expected = config?.transport === 'desktop' ? window : window.parent;
        if (event.source !== expected)
            return;
        const message = event.data;
        try { json(message); } catch { return; }
        if (!message || message.protocol !== 1 || message.instanceId !== config?.instanceId || message.nonce !== config?.nonce || message.revisionId !== config?.revisionId)
            return;
        if (message.type === 'connect' && !connected) {
            if (config?.transport !== 'desktop' && !event.ports[0])
                return;
            connected = true;
            if (config?.transport !== 'desktop') {
                port = event.ports[0];
                port.onmessage = e => accept(e.data);
                port.start();
                window.removeEventListener('message', onWindow);
            }
            if (connectTimer)
                clearTimeout(connectTimer);
            connectResolve();
        }
        else if (config?.transport === 'desktop' && connected)
            accept(message);
    }
    if (!standalone) {
        window.addEventListener('message', onWindow);
        (config.transport === 'desktop' ? window : window.parent).postMessage(envelope('hello', {}), '*');
    }
    else
        connectResolve();
    function subscribe(kind, listener) { listeners[kind].add(listener); return () => listeners[kind].delete(listener); }
    let readyPromise;
    let heightTimer;
    let nextHeight = 380;
    const api = Object.freeze({
        ready() {
            return readyPromise || (readyPromise = (async () => {
                if (!standalone) {
                    const initial = await request('ready');
                    state = json(initial.state, 16384);
                    locale = initial.locale;
                    applyTheme(initial.theme);
                }
                else
                    applyTheme(window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
                return { theme, locale, state: json(state), standalone };
            })());
        },
        getState: () => json(state),
        async setState(next) {
            await api.ready();
            json(next, 16384);
            if (!next || Array.isArray(next) || typeof next !== 'object' || Object.keys(next).some(k => !['privateState', 'modelState'].includes(k)))
                throw new Error('Only privateState and modelState may be set.');
            const value = json({ ...state, ...next }, 16384);
            state = !standalone ? json(await request('state', next), 16384) : value;
            emit('state', state);
        },
        onThemeChange: (listener) => subscribe('theme', listener),
        onStateChange: (listener) => subscribe('state', listener),
        onControlsChange: (listener) => { const unsubscribe = subscribe('controls', listener); listener(json(state.controls)); return unsubscribe; },
        reportHeight(height) {
            if (!Number.isFinite(height) || standalone)
                return;
            nextHeight = Math.max(96, Math.min(640, Math.round(height)));
            if (heightTimer)
                return;
            heightTimer = setTimeout(() => { heightTimer = undefined; void request('resize', { height: nextHeight }).catch(() => { }); }, 200);
        },
        async registerControls(schema) {
            await api.ready();
            validateControls(schema);
            if (!standalone) {
                const result = await request('controls', schema);
                state.controls = result;
                emit('controls', result);
                return;
            }
            const values = {};
            for (const control of schema) {
                if (!control || typeof control.key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(control.key))
                    throw new Error('Invalid control.');
                values[control.key] = control.defaultValue;
            }
            state.controls = json(values, 16384);
            emit('controls', state.controls);
        },
        async requestFeedbackDraft(input) {
            json(input, 16384);
            if (standalone)
                throw new Error('Feedback is unavailable in standalone exports. Open this artifact in Synax.');
            await request('feedbackDraft', input);
        },
    });
    Object.defineProperty(w, 'synaxWidget', { value: api, writable: false, configurable: false });
    // Bounded local diagnostics; they never enter feedback/model state automatically.
    if (!standalone) {
        const diagnostic = (level, message) => {
            const text = String(message).slice(0, 450);
            void request('log', {level, message:text}).catch(() => {});
        };
        for (const level of ['log','info','warn','error']) {
            const original = console[level].bind(console);
            console[level] = (...args) => {
                original(...args);
                diagnostic(level, args.map(value => typeof value === 'string' ? value : '[non-string value]').join(' '));
            };
        }
        window.addEventListener('error', event => diagnostic('error', event.message || 'Preview error'));
        window.addEventListener('unhandledrejection', event => diagnostic('error', event.reason instanceof Error ? event.reason.message : 'Unhandled preview rejection'));
    }
    function observe() {
        const measure = () => {
            const body = document.body;
            // CSS-hidden frames have a zero viewport. Do not persist that transient
            // measurement, and never use root.scrollHeight (it is >= iframe height).
            if (!body || document.documentElement.clientWidth === 0) return;
            const rect = body.getBoundingClientRect();
            const style = getComputedStyle(body);
            const px = value => Number.parseFloat(value) || 0;
            const range = document.createRange();
            range.selectNodeContents(body);
            const content = range.getBoundingClientRect();
            const margin = px(style.marginBottom);
            const bodyBottom = rect.bottom + window.scrollY + margin;
            const contentBottom = content.bottom + window.scrollY + margin + px(style.paddingBottom) + px(style.borderBottomWidth);
            api.reportHeight(Math.max(bodyBottom, contentBottom));
        };
        if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measure).observe(document.body || document.documentElement);
        measure();
        document.addEventListener('click', event => {
            if (!picking || !(event.target instanceof Element))
                return;
            event.preventDefault();
            event.stopImmediatePropagation();
            picking = false;
            document.documentElement.style.cursor = '';
            const target = event.target;
            const qaId = target.closest('[data-qa-id]')?.getAttribute('data-qa-id');
            // Never read input values, password fields, HTML, or arbitrary attributes.
            const element = { tag: target.tagName.toLowerCase(), text: (target.textContent || '').slice(0, 500), ...(qaId ? { qaId: qaId.slice(0, 120) } : {}) };
            void request('element', element).catch(() => { });
        }, true);
    }
    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', observe, { once: true });
    else
        observe();
})();`;
}
