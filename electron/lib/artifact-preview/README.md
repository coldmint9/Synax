# Isolated prototype transport

The internal artifact-preview name is retained to avoid unnecessary churn in
transport registration. Identity envelopes now bind prototypeId, instanceId and
nonce. The host preload exposes only create/update/send/destroy/onMessage;
screenshot and annotation IPC no longer exist. The runtime permits hello, ready
and resize; the host permits connect, response and theme only.

Independent ephemeral WebContentsView sessions retain sandboxing, Node denial,
network/proxy/STUN denial, blocked navigation/download/permissions, bounded JSON,
rate limits, owner checks, clipping/zoom and hung-renderer termination. At most
two previews run simultaneously. Main-only native pixel capture remains solely
for transport smoke verification; it is not available to generated or host UI.

Run `npm run build:electron`, then
`SYNAX_ARTIFACT_NATIVE_SMOKE=1 npx vitest run electron/lib/artifact-preview`.
Packaged transcript acceptance: `npm run test:prototypes:desktop` after packaging.
Windows/WSL and mixed-DPI transitions require matching environments; a macOS
pass must never be reported as evidence of those platforms.
