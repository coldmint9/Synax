import { SharedObservationHub } from "./shared-hub";
const hub = new SharedObservationHub();
const worker = globalThis as unknown as { onconnect: (event: MessageEvent & { ports: MessagePort[] }) => void };
worker.onconnect = event => { for (const port of event.ports) hub.attach(port); };
