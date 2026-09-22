import { createHash } from "node:crypto";
export const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
