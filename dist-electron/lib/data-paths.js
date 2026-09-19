import { app } from "electron";
import path from "node:path";
export function getDataRoot() {
    if (process.env.DATA_ROOT)
        return path.resolve(process.env.DATA_ROOT);
    return path.join(app.getPath("home"), ".synax");
}
export function getResourcePath(...segments) {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, ...segments);
    }
    return path.resolve(app.getAppPath(), ...segments);
}
