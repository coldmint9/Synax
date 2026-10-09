import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
// Accept only ordinary global IPv6 unicast. This also excludes mapped IPv4,
// NAT64, link-local, unique-local, multicast and unspecified addresses.
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) blocked.addSubnet(address, prefix, "ipv6");

function assertPublic(address: string): void {
  const family = isIP(address);
  if (!family || (family === 4
    ? blocked.check(address, "ipv4")
    : !globalV6.check(address, "ipv6") || blocked.check(address, "ipv6"))) {
    throw new Error("Remote image address is private or reserved");
  }
}

function parseUrl(raw: string, base?: URL): URL {
  const url = new URL(raw, base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Remote images require HTTP(S) without credentials");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (/^(localhost|.*\.localhost)\.?$/.test(hostname)) {
    throw new Error("Remote image address is private or reserved");
  }
  return url;
}

const extensions: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
  "image/webp": "webp", "image/avif": "avif", "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

function sniff(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.toString("latin1", 0, 6))) return "image/gif";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 26 && bytes.toString("latin1", 0, 2) === "BM") return "image/bmp";
  if (bytes.length >= 16 && bytes.toString("latin1", 4, 8) === "ftyp") {
    const size = bytes.readUInt32BE(0);
    if (size >= 16 && size <= bytes.length && size % 4 === 0) {
      for (let offset = 8; offset < size; offset += 4) {
        if (offset !== 12 && /^(avif|avis)$/.test(bytes.toString("latin1", offset, offset + 4))) return "image/avif";
      }
    }
  }
  // Identify the document root, not an <svg> embedded in an HTML document.
  // Do not parse XML, fetch entities or rasterize here. DTDs are unsupported.
  let prefix = bytes.subarray(0, 65536).toString("utf8").trimStart();
  if (/^<\?xml\s/.test(prefix)) {
    const end = prefix.indexOf("?>");
    if (end < 0) return undefined;
    prefix = prefix.slice(end + 2).trimStart();
  }
  // Scan comments explicitly to avoid pathological XML-prefix regex backtracking.
  while (prefix.startsWith("<!--")) {
    const end = prefix.indexOf("-->", 4);
    if (end < 0) return undefined;
    prefix = prefix.slice(end + 3).trimStart();
  }
  if (/^<svg(?:\s|\/?>)/.test(prefix)) return "image/svg+xml";
  return undefined;
}

type Download = { bytes: Buffer; filename: string; mediaType: string };
type Hop = { redirect: string } | { bytes: Buffer; mediaType: string };

async function download(url: URL, maxBytes: number, signal: AbortSignal): Promise<Download> {
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const family = isIP(hostname);
    const addresses = family ? [{ address: hostname, family }] : await lookup(hostname, { all: true, verbatim: true });
    signal.throwIfAborted();
    if (!addresses.length) throw new Error("Remote image DNS returned no addresses");
    for (const item of addresses) assertPublic(item.address);
    const selected = addresses[0];
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [selected]);
      else callback(null, selected.address, selected.family);
    };
    const hop = await new Promise<Hop>((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).request(url, {
        method: "GET", agent: false, lookup: pinnedLookup, family: selected.family,
        signal, maxHeaderSize: 16384,
        headers: { Accept: Object.keys(extensions).join(", "), "Accept-Encoding": "identity" },
      }, (response) => {
        const fail = (error: Error) => { reject(error); response.destroy(); request.destroy(); };
        response.on("error", reject);
        response.on("aborted", () => reject(new Error("Remote image response aborted")));
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          if (!location) { fail(new Error("Remote image redirect has no Location")); return; }
          resolve({ redirect: location });
          response.destroy();
          request.destroy();
          return;
        }
        if (status < 200 || status >= 300) { fail(new Error(`Remote image HTTP status ${status}`)); return; }
        const mediaType = (response.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (!Object.hasOwn(extensions, mediaType)) { fail(new Error("Unsupported remote image content-type")); return; }
        const encoding = response.headers["content-encoding"];
        if (encoding && encoding.toLowerCase() !== "identity") { fail(new Error("Unsupported remote image content-encoding")); return; }
        const length = response.headers["content-length"];
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
          fail(new Error("Remote image exceeds byte limit")); return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) { fail(new Error("Remote image exceeds byte limit")); return; }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (!response.complete) { fail(new Error("Remote image response incomplete")); return; }
          resolve({ bytes: Buffer.concat(chunks, size), mediaType });
        });
      });
      request.on("error", reject);
      request.end();
    });
    signal.throwIfAborted();
    if ("redirect" in hop) {
      if (redirects >= 5) throw new Error("Remote image exceeds redirect limit");
      url = parseUrl(hop.redirect, url);
      continue;
    }
    if (sniff(hop.bytes) !== hop.mediaType) throw new Error("Remote image contents do not match content-type");
    let name: string;
    try { name = decodeURIComponent(url.pathname.split("/").pop() ?? ""); }
    catch { name = "image"; }
    const stem = name.replace(/\.[^.]*$/, "").replace(/[^\p{L}\p{N}_-]/gu, "_").slice(0, 120) || "image";
    return { ...hop, filename: `${stem}.${extensions[hop.mediaType]}` };
  }
}

/** Bounded HTTP(S) image download. Caller owns permission checks and SVG rendering. */
export async function fetchRemoteImage(rawUrl: string, maxBytes: number): Promise<Download> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid remote image byte limit");
  const url = parseUrl(rawUrl);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Remote image download timed out after 15000ms");
      reject(error);
      controller.abort(error);
    }, 15000);
  });
  try { return await Promise.race([download(url, maxBytes, controller.signal), deadline]); }
  finally { clearTimeout(timer); }
}
