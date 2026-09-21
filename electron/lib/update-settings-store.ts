import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_UPDATE_NETWORK,
  validateUpdateNetworkSettings,
  type UpdateNetworkSettings,
} from "./update-network.js";

export class UpdateSettingsStore {
  private value: UpdateNetworkSettings = { ...DEFAULT_UPDATE_NETWORK };
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  get settings(): UpdateNetworkSettings {
    return { ...this.value };
  }

  async initialize(): Promise<void> {
    try {
      this.value = validateUpdateNetworkSettings(
        JSON.parse(await fs.readFile(this.file, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        console.warn(
          "[update-settings] Cannot load settings; using GitHub directly",
          error,
        );
    }
  }

  save(value: unknown): Promise<UpdateNetworkSettings> {
    const settings = validateUpdateNetworkSettings(value);
    const task = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(settings), {
          mode: 0o600,
          flag: "wx",
        });
        await fs.rename(temporary, this.file);
        this.value = settings;
        return this.settings;
      } finally {
        await fs.rm(temporary, { force: true });
      }
    });
    this.writing = task.catch(() => {});
    return task;
  }
}
