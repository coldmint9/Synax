import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import { showAboutWindow } from "./dist-electron/about-window.js";

app.whenReady().then(() => {
  showAboutWindow();
  const win = BrowserWindow.getAllWindows()[0];
  setTimeout(() => {
    win.webContents
      .capturePage()
      .then((image) => {
        writeFileSync(process.env.ABOUT_SHOT, image.toPNG());
        app.quit();
      })
      .catch(() => app.quit());
  }, 1500);
});
