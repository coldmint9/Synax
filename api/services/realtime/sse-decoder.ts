export interface ObservationEvent {
  event: string;
  data: string;
  lastEventId?: string;
}

/** The wire contract is still SSE; only the physical transport changes. */
export class SseDecoder {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private lastId = "";
  constructor(private readonly emit: (event: ObservationEvent) => void,
    private readonly maxBytes = 8 * 1024 * 1024) {}

  push(bytes: Uint8Array): void {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    let delimiter: RegExpExecArray | null;
    while ((delimiter = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, delimiter.index);
      this.assertSize(frame);
      this.buffer = this.buffer.slice(delimiter.index + delimiter[0].length);
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value || "message";
        if (field === "data") data.push(value);
        if (field === "id" && !value.includes("\0")) this.lastId = value;
      }
      if (data.length) this.emit({ event, data: data.join("\n"), lastEventId: this.lastId });
    }
    this.assertSize(this.buffer);
  }
  private assertSize(value: string): void {
    if (Buffer.byteLength(value) > this.maxBytes) throw new Error("Observation frame exceeds its byte budget.");
  }
}
