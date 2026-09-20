import { Hono } from "hono";
import { listWslDistributions, WslError } from "../services/wsl.js";

export const wslRoutes = new Hono();

wslRoutes.get("/distributions", async (c) => {
  if (process.platform !== "win32") {
    return c.json({
      available: false,
      reason: "WSL2 project support is only available on Windows.",
      items: [],
    });
  }
  try {
    const items = await listWslDistributions();
    return c.json({
      available: items.length > 0,
      reason: items.length ? undefined : "No WSL2 distributions are installed.",
      items,
    });
  } catch (error) {
    return c.json({
      available: false,
      reason: error instanceof Error ? error.message : "WSL2 is unavailable.",
      items: [],
      code: error instanceof WslError ? error.code : "WSL_UNAVAILABLE",
    });
  }
});
