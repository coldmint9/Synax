import { Hono } from "hono";
import { completeWebSearchOAuth } from "../services/web-search/oauth.js";

export const webSearchOAuthRoutes = new Hono();

webSearchOAuthRoutes.get("/callback", async (c) => {
  const error = c.req.query("error");
  const description = c.req.query("error_description");
  try {
    if (error) throw new Error(description || error);
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!state || !code)
      throw new Error("OAuth callback is missing state or code.");
    await completeWebSearchOAuth({ state, code });
    return c.html(oauthPage(true, "Web search authorization completed."));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return c.html(oauthPage(false, message), 400);
  }
});

function oauthPage(ok: boolean, message: string): string {
  const title = ok ? "Connected" : "Authorization failed";
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title></head><body style="font:14px system-ui;padding:32px"><h1>${safeTitle}</h1><p>${safeMessage}</p><script>if(window.opener){window.opener.postMessage({type:'synax:web-search-oauth',ok:${ok}},'*')}setTimeout(()=>window.close(),800)</script></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );
}
