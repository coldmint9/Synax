import { useEffect, useMemo, useState } from "react";
import { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import { agentRuntimeApi } from "../../adapters/transport/agentRuntime";
import { MarkdownImage } from "../../shared/ui/markdown/MarkdownImage";
import { parseFileLink, type FileLinkRoot } from "./fileLink";

interface Scope {
  sessionId: string | null;
  workspacePath?: string | null;
  roots?: readonly FileLinkRoot[];
  path?: string;
  rootId?: string;
}

export function resolveMarkdownImage(src: string, scope: Scope) {
  if (!src || /^(?:https?:|\/\/|data:|blob:)/i.test(src)) return null;
  if (/^(?:file:|\/|[a-z]:[\\/])/i.test(src)) {
    return parseFileLink(src, undefined, scope.workspacePath, scope.roots);
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(src)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(src.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  const parts = scope.path?.replace(/\\/g, "/").split("/").slice(0, -1) ?? [];
  for (const part of decoded.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? { path: parts.join("/"), rootId: scope.rootId } : null;
}

function WorkspaceMarkdownImage({ src = "", alt = "", title, scope }: {
  src?: string;
  alt?: string;
  title?: string;
  scope: Scope;
}) {
  const target = scope.sessionId ? resolveMarkdownImage(src, scope) : null;
  const sessionId = scope.sessionId;
  const path = target?.path;
  const rootId = target?.rootId;
  const key = JSON.stringify([sessionId, path, rootId]);
  const [loaded, setLoaded] = useState<{ key: string; url?: string }>();
  useEffect(() => {
    if (!sessionId || !path) return;
    let disposed = false;
    let objectUrl: string | undefined;
    void agentRuntimeApi.getSessionEnvironmentFileMedia(sessionId, path, rootId)
      .then((blob) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ key, url: objectUrl });
      })
      .catch(() => {
        if (!disposed) setLoaded({ key });
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sessionId, path, rootId, key]);

  if (!target) return <MarkdownImage src={defaultUrlTransform(src)} alt={alt} title={title} />;
  if (loaded?.key !== key) return <span role="status">图片加载中{alt ? `：${alt}` : ""}</span>;
  if (!loaded.url) return <span className="markdown-image-error" role="status">图片加载失败{alt ? `：${alt}` : ""}</span>;
  return <MarkdownImage src={loaded.url} alt={alt} title={title} />;
}

export function useWorkspaceMarkdownImages(scope: Scope): {
  components: Components;
  urlTransform: UrlTransform;
} {
  const { sessionId, workspacePath, roots, path, rootId } = scope;
  return useMemo(() => {
    const imageScope = { sessionId, workspacePath, roots, path, rootId };
    return {
      components: {
        img: ({ src, alt, title }) => <WorkspaceMarkdownImage src={src} alt={alt} title={title} scope={imageScope} />,
      },
      urlTransform: (url, key) => key === "src" && sessionId && resolveMarkdownImage(url, imageScope)
        ? url : defaultUrlTransform(url),
    };
  }, [sessionId, workspacePath, roots, path, rootId]);
}
