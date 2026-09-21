# Isolated desktop artifact transport

The app preload exposes only `artifactPreview.create`, `update`, `send`, `destroy`
and `onMessage` (the listener returns an unsubscribe function synchronously).
`create` starts hidden; the host must subscribe first and then send a visible
`update` after creation. Bounds are content-window CSS coordinates. `bounds.clip`
is the intersection of scroll-ancestor viewports; main also intersects the window
viewport. Host overlays, menus, drag surfaces and inactive tabs must send
`visible: false`. A bound `transport-needs-layout` event requests a fresh update
following native window changes; it does not automatically show a preview.

The provided HTML is served unchanged, once, through an early-registered private
protocol. Its SDK runtime meta must already contain protocol 1, instanceId,
revisionId, nonce and transport `desktop`. The dedicated sandbox preload forwards
only bound, direction-allowlisted `window.postMessage` envelopes. It exposes no
main-world Electron API. Main repeats JSON, byte, identity, ownership and rate
checks and enforces a one-time hello/connect handshake.

Each view uses its own nonpersistent partition, denied permissions/downloads/
navigation/popups, restrictive response CSP, exact-document request policy and an
owned reject-only proxy with non-proxied WebRTC UDP disabled. Partitions are never
reused. Destroy removes the native surface, closes web contents without waiting
for beforeunload, seals the session and clears its storage/connections. An isolated
preload heartbeat and native unresponsive events stop hung renderers. At most two
instances are active; IDs cannot be reused within the owning window's lifetime.

## Native clipping

On Electron 39/macOS a parent `View` does **not** clip a native child. Therefore
we constrain the actual WebContentsView surface to the visible rectangle and use
one fixed internal `Emulation.setDeviceMetricsOverride` command to preserve the
full document layout while cropping its compositor viewport. Retina offsets and
host zoom are accounted for. There is no arbitrary CDP or JavaScript-evaluation
entry point. Failed viewport setup closes the preview rather than displaying an
unclipped surface. Async layout generations cannot restore a newer hidden view.

`ArtifactPreviewManager.capture(owner, id)` provides a real cropped NativeImage
to main-process callers only. There is no capture IPC or screenshot UI in this
change. A WebContents screenshot cannot prove composition of sibling native
views; the native smoke also uses the OS window thumbnail when available.

## Verification

```sh
npm run build:electron
npx vitest run electron
SYNAX_ARTIFACT_NATIVE_SMOKE=1 npx vitest run electron/lib/artifact-preview/native-smoke.test.ts
```

The opt-in smoke launches the installed Electron against `native-smoke.ts`'s
compiled fixture, with a temporary profile. It exercises the real SDK, separate
sessions, max-two enforcement, fixed bridge, HTTP/WebSocket/image/media/STUN
negative probes against local HTTP/UDP receivers, crop/zoom capture and a renderer
infinite loop while the host and sibling remain alive. Screenshots are written
to a temporary `synax-artifact-native-*` directory. It needs a graphical session
and may briefly focus the fixture window; native blur intentionally hides views.

Verified locally on macOS with Electron 39.8.10 on September 21, 2026. This is a
transport harness, not an end-to-end published-artifact/product-UI test. Windows,
Linux, mixed-DPI monitor transitions, and full-app overlay/focus/accessibility
regressions still require native QA on those platforms.
