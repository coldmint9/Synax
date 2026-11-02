import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_UPDATE_SETTINGS,
  validateUpdateSettings,
  type UpdateSettings,
} from "../updater/update-settings.js";

/** Stores user update preferences. The file keeps its historical name so
 * existing installations keep their proxy choice across the upgrade. */
export class UpdateSettingsStore {
  private value: UpdateSettings = { ...DEFAULT_UPDATE_SETTINGS };
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  get settings(): UpdateSettings {
    return { ...this.value };
  }

  async initialize(): Promise<void> {
    try {
      this.value = validateUpdateSettings(
        JSON.parse(await fs.readFile(this.file, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        console.warn(
          "[update-settings] Cannot load settings; online updates stay off",
          error,
        );
    }
  }

  save(value: unknown): Promise<UpdateSettings> {
    const settings = validateUpdateSettings(value);
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
