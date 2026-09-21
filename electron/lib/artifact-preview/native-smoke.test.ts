import { afterAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createSocket } from "node:dgram";
import { artifactSdkSource } from "../../../api/services/agent-runtime/artifacts/runtime-sdk.js";

const native = process.env.SYNAX_ARTIFACT_NATIVE_SMOKE === "1";
describe.skipIf(!native)("real Electron artifact transport", () => {
  let desktop: ElectronApplication;
  const httpServer = createServer((_req, res) => {
    networkHits++;
    res.end("unexpected");
  });
  const udpServer = createSocket("udp4");
  let networkHits = 0;
  udpServer.on("message", () => networkHits++);
  afterAll(async () => {
    await desktop?.close();
    httpServer.close();
    try {
      udpServer.close();
    } catch {}
  });
  it("isolates sessions, transports fixed envelopes, clips/captures, blocks escape and kills hangs", async () => {
    await new Promise<void>((resolve) =>
      httpServer.listen(0, "127.0.0.1", resolve),
    );
    await new Promise<void>((resolve) =>
      udpServer.bind(0, "127.0.0.1", resolve),
    );
    const httpPort = (httpServer.address() as any).port;
    const udpPort = udpServer.address().port;
    const output = await mkdtemp(path.join(tmpdir(), "synax-artifact-native-"));
    const env = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    desktop = await _electron.launch({
      executablePath: createRequire(import.meta.url)("electron"),
      args: [
        path.resolve("dist-electron/lib/artifact-preview/native-smoke.js"),
        `--user-data-dir=${output}/profile`,
      ],
      env,
      timeout: 30000,
    });
    const page = await desktop.firstWindow();
    await page.waitForFunction(() => !!(window as any).electronAPI);
    const id = "native-one",
      revisionId = "revision-one",
      nonce = "n".repeat(32);
    const config = { protocol: 1, instanceId: id, revisionId, nonce };
    const html = `<html><body style="margin:0;background:red;height:400px"><div style="height:60px;background:lime"></div><div style="position:absolute;left:60px;top:100px;width:160px;height:180px;background:yellow"></div><script>
      const config=${JSON.stringify(config)};
      const send=(type,payload={},requestId)=>window.postMessage({...config,type,payload,...(requestId?{requestId}:{})},'*');
      window.addEventListener('message',async e=>{if(e.data.type==='connect') {
        const tests={node:typeof require, electron:typeof window.electronAPI, bridge:typeof window.artifactTransport};
        try { await fetch('http://127.0.0.1:${httpPort}/leak'); tests.fetch='escaped'; } catch { tests.fetch='blocked'; }
        try { tests.popup=window.open('https://example.com')===null?'blocked':'escaped'; } catch { tests.popup='blocked'; }
        try { localStorage.setItem('secret','x'); tests.storage='available'; } catch { tests.storage='blocked'; }
        try { const ws=new WebSocket('ws://127.0.0.1:${httpPort}/socket'); ws.onerror=()=>{}; } catch {}
        const img=new Image();img.src='http://127.0.0.1:${httpPort}/image';
        try { await navigator.mediaDevices.getUserMedia({audio:true});tests.media='escaped'; } catch {tests.media='blocked';}
        try {const pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udpPort}'}]});pc.createDataChannel('probe');await pc.setLocalDescription(await pc.createOffer());await new Promise(r=>setTimeout(r,800));pc.close();tests.webrtc='attempted';}catch{tests.webrtc='unavailable';}
        send('ready',tests,'1');
      } if(e.data.type==='pick') { location.href='https://example.com/leak'; setTimeout(()=>send('log',{stillHere:location.protocol}),100); }
      if(e.data.type==='controlsChanged') { while(true){} }
      }); send('hello');
      </script></body></html>`;
    await page.evaluate(() => {
      (window as any).events = [];
      (window as any).electronAPI.artifactPreview.onMessage((e: any) =>
        (window as any).events.push(e),
      );
    });
    await page.evaluate(
      async ({ id, html, revisionId, nonce }) => {
        await (window as any).electronAPI.artifactPreview.create({
          id,
          html,
          revisionId,
          nonce,
          bounds: {
            x: -20,
            y: -60,
            width: 320,
            height: 400,
            clip: { x: 40, y: 40, width: 160, height: 180 },
          },
        });
      },
      { id, html, revisionId, nonce },
    );
    await page.waitForFunction(() =>
      (window as any).events.some((e: any) => e.message.type === "hello"),
    );
    await page.evaluate(
      async ({ id, config }) => {
        await (window as any).electronAPI.artifactPreview.send({
          id,
          message: { ...config, type: "connect" },
        });
      },
      { id, config },
    );
    await page.waitForFunction(() =>
      (window as any).events.some((e: any) => e.message.type === "ready"),
    );
    const ready = await page.evaluate(
      () =>
        (window as any).events.find((e: any) => e.message.type === "ready")
          .message.payload,
    );
    expect(ready).toEqual({
      node: "undefined",
      electron: "undefined",
      bridge: "undefined",
      fetch: "blocked",
      popup: "blocked",
      storage: "blocked",
      media: "blocked",
      webrtc: "attempted",
    });
    await desktop.evaluate(({ app }) => {
      app.focus({ steal: true });
      (globalThis as any).artifactSmoke.owner.focus();
    });
    await page.evaluate(async (id) => {
      await (window as any).electronAPI.artifactPreview.update({
        id,
        bounds: {
          x: -20,
          y: -60,
          width: 320,
          height: 400,
          clip: { x: 40, y: 40, width: 160, height: 180 },
        },
        visible: true,
      });
    }, id);
    const capture = await desktop.evaluate(
      async ({ desktopCapturer }, { id, output }) => {
        const { owner, manager, writeFile } = (globalThis as any).artifactSmoke;
        // Capture the live preview before the slower OS-window enumeration. Native
        // blur deliberately hides views, so another app stealing focus must not be
        // confused with a transport failure.
        const artifact = await manager.capture(owner, id);
        await writeFile(`${output}/artifact.png`, artifact.toPNG());
        const sources = await desktopCapturer.getSources({
          types: ["window"],
          thumbnailSize: { width: 1600, height: 1200 },
        });
        const source = sources.find((s) => s.id === owner.getMediaSourceId());
        const image =
          source?.thumbnail ?? (await owner.webContents.capturePage());
        await writeFile(`${output}/host.png`, image.toPNG());
        const b = image.toBitmap();
        const size = image.getSize();
        const windowBounds = owner.getBounds(),
          contentBounds = owner.getContentBounds();
        const sx = size.width / windowBounds.width,
          sy = size.height / windowBounds.height;
        const pixel = (x: number, y: number) => {
          const offset =
            (Math.floor((y + contentBounds.y - windowBounds.y) * sy) *
              size.width +
              Math.floor((x + contentBounds.x - windowBounds.x) * sx)) *
            4;
          return [...b.subarray(offset, offset + 4)];
        };
        return {
          capture: artifact.getSize(),
          screenshot: size,
          composited: !!source,
          outside: pixel(20, 100),
          inside: pixel(80, 100),
          far: pixel(250, 100),
          output,
        };
      },
      { id, output },
    );
    console.log("Artifact native screenshots:", capture);
    expect(capture.capture.width / capture.capture.height).toBeCloseTo(
      160 / 180,
    );
    expect(capture.capture.width).toBeGreaterThanOrEqual(160);
    if (capture.composited) {
      for (const pixel of [capture.outside, capture.far]) {
        expect(pixel[0]).toBeGreaterThan(180);
        expect(pixel[2]).toBeLessThan(100);
      }
      expect(capture.inside[0]).toBeLessThan(100);
      expect(capture.inside[1]).toBeGreaterThan(180);
      expect(capture.inside[2]).toBeGreaterThan(180);
    }
    // Browser zoom must preserve both clipping and the artifact's CSS layout viewport.
    await desktop.evaluate(() =>
      (globalThis as any).artifactSmoke.owner.webContents.setZoomFactor(2),
    );
    await desktop.evaluate(({ app }) => {
      app.focus({ steal: true });
      (globalThis as any).artifactSmoke.owner.focus();
    });
    await page.evaluate(async (id) => {
      await (window as any).electronAPI.artifactPreview.update({
        id,
        bounds: {
          x: -20,
          y: -60,
          width: 320,
          height: 400,
          clip: { x: 40, y: 40, width: 160, height: 180 },
        },
        visible: true,
      });
    }, id);
    const zoomed = await desktop.evaluate(
      async ({ desktopCapturer }, { id, output }) => {
        const { owner, manager, writeFile } = (globalThis as any).artifactSmoke;
        const image = await manager.capture(owner, id);
        await writeFile(`${output}/artifact-zoom2.png`, image.toPNG());
        const bitmap = image.toBitmap();
        const size = image.getSize();
        const center =
          (Math.floor(size.height / 2) * size.width +
            Math.floor(size.width / 2)) *
          4;
        const sources = await desktopCapturer.getSources({
          types: ["window"],
          thumbnailSize: { width: 1600, height: 1200 },
        });
        const source = sources.find((s) => s.id === owner.getMediaSourceId());
        if (source)
          await writeFile(`${output}/host-zoom2.png`, source.thumbnail.toPNG());
        return { size, center: [...bitmap.subarray(center, center + 4)] };
      },
      { id, output },
    );
    expect(zoomed.size.width / capture.capture.width).toBeCloseTo(2);
    expect(zoomed.center[0]).toBeLessThan(100);
    expect(zoomed.center[1]).toBeGreaterThan(180);
    expect(zoomed.center[2]).toBeGreaterThan(180);
    await desktop.evaluate(() =>
      (globalThis as any).artifactSmoke.owner.webContents.setZoomFactor(1),
    );

    const isolated = await desktop.evaluate(({ webContents }) => {
      const { owner } = (globalThis as any).artifactSmoke;
      const artifact = webContents
        .getAllWebContents()
        .find((w) => w.getURL().startsWith("synax-artifact:"))!;
      return {
        separate: artifact.session !== owner.webContents.session,
        persistent: artifact.session.isPersistent(),
        preload: artifact.getLastWebPreferences().preload,
        sandbox: artifact.getLastWebPreferences().sandbox,
        contextIsolation: artifact.getLastWebPreferences().contextIsolation,
        nodeIntegration: artifact.getLastWebPreferences().nodeIntegration,
      };
    });
    expect(isolated).toMatchObject({
      separate: true,
      persistent: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    console.log("native preferences", isolated);
    await page.evaluate(
      async ({ id, config }) => {
        await (window as any).electronAPI.artifactPreview.send({
          id,
          message: { ...config, type: "pick", payload: { enabled: true } },
        });
      },
      { id, config },
    );
    await page.waitForFunction(() =>
      (window as any).events.some((e: any) => e.message.type === "log"),
    );
    expect(
      await page.evaluate(
        () =>
          (window as any).events.find((e: any) => e.message.type === "log")
            .message.payload.stillHere,
      ),
    ).toBe("synax-artifact:");
    // Load the real shared SDK in a second, distinct ephemeral renderer/session.
    const sdkConfig = {
      protocol: 1,
      instanceId: "native-sdk",
      nonce: "s".repeat(32),
      revisionId: "sdk-revision",
      transport: "desktop",
    };
    const sdkHtml = `<html><head><meta name="synax-artifact-runtime" content='${JSON.stringify(sdkConfig)}'><script>${artifactSdkSource()}</script></head><body><script>synaxWidget.ready().then(()=>synaxWidget.setState({modelState:{nativeSdk:true}}));</script></body></html>`;
    await page.evaluate(
      async ({ sdkConfig, sdkHtml }) => {
        const api = (window as any).electronAPI.artifactPreview;
        api.onMessage((event: any) => {
          if (event.id !== sdkConfig.instanceId) return;
          const m = event.message;
          if (m.type === "hello")
            void api.send({
              id: event.id,
              message: { ...sdkConfig, type: "connect" },
            });
          else if (m.type === "ready")
            void api.send({
              id: event.id,
              message: {
                ...sdkConfig,
                type: "response",
                requestId: m.requestId,
                payload: {
                  result: {
                    theme: "light",
                    locale: "en",
                    state: {
                      privateState: null,
                      modelState: null,
                      controls: {},
                      schemaVersion: 1,
                      etag: 0,
                    },
                  },
                },
              },
            });
          else if (m.requestId)
            void api.send({
              id: event.id,
              message: {
                ...sdkConfig,
                type: "response",
                requestId: m.requestId,
                payload: { result: null },
              },
            });
        });
        await api.create({
          id: sdkConfig.instanceId,
          nonce: sdkConfig.nonce,
          revisionId: sdkConfig.revisionId,
          html: sdkHtml,
          bounds: { x: 400, y: 0, width: 300, height: 300 },
        });
      },
      { sdkConfig, sdkHtml },
    );
    await page.waitForFunction(() =>
      (window as any).events.some(
        (e: any) =>
          e.id === "native-sdk" &&
          e.message.type === "state" &&
          e.message.payload.modelState.nativeSdk === true,
      ),
    );
    const sessionCount = await desktop.evaluate(
      ({ webContents }) =>
        new Set(
          webContents
            .getAllWebContents()
            .filter((w) => w.getURL().startsWith("synax-artifact:"))
            .map((w) => w.session),
        ).size,
    );
    expect(sessionCount).toBe(2);
    const third = await page.evaluate(async () => {
      try {
        await (window as any).electronAPI.artifactPreview.create({
          id: "third",
          nonce: "t".repeat(32),
          revisionId: "third",
          html: "hello",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
        });
        return "accepted";
      } catch {
        return "blocked";
      }
    });
    expect(third).toBe("blocked");
    // Let the isolated heartbeat run, then block that renderer's JS thread.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await page.evaluate(
      async ({ id, config }) => {
        await (window as any).electronAPI.artifactPreview.send({
          id,
          message: { ...config, type: "controlsChanged", payload: {} },
        });
      },
      { id, config },
    );
    await page.waitForFunction(
      () =>
        (window as any).events.some(
          (e: any) => e.message.code === "RUNTIME_UNRESPONSIVE",
        ),
      undefined,
      { timeout: 16000 },
    );
    expect(
      await desktop.evaluate(
        ({ webContents }) =>
          webContents
            .getAllWebContents()
            .filter((w) => w.getURL().startsWith("synax-artifact:")).length,
      ),
    ).toBe(1);
    expect(networkHits).toBe(0);
    await page.evaluate(async () =>
      (window as any).electronAPI.artifactPreview.destroy("native-sdk"),
    );
    expect(
      await page.evaluate(() => document.querySelector("h1")?.textContent),
    ).toContain("fixture");
  }, 60000);
});
