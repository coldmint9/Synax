import { useCallback, useMemo } from "react";
import type { Components } from "react-markdown";
import {
  openFileLinkTarget,
  reportFileLinkFailure,
} from "./fileLinkOpen";
import { resolveDocumentLink, type FileLinkTarget } from "./fileLink";

interface Scope {
  sessionId: string;
  /** Repository-relative path of the document whose anchors are rendered. */
  documentPath: string;
  rootId?: string;
}

/**
 * Anchors inside a previewed markdown file.
 *
 * A relative destination belongs to the document's own folder, so the viewer
 * opens it in place instead of letting the window navigate to a path the
 * runtime cannot serve. A destination the workspace cannot open becomes a
 * notification; nothing opens behind it.
 */
export function useDocumentFileLinks({
  sessionId,
  documentPath,
  rootId,
}: Scope): Pick<Components, "a"> {
  const open = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>, target: FileLinkTarget) => {
      event.preventDefault();
      void openFileLinkTarget(sessionId, target);
    },
    [sessionId],
  );

  return useMemo(
    () => ({
      a({ href, children, node: _node, ...props }) {
        const link = resolveDocumentLink(href, documentPath, rootId);
        if (link.kind === "external") {
          return (
            <a {...props} href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          );
        }
        if (link.kind === "unresolved") {
          return (
            <a
              {...props}
              href={href}
              onClick={(event) => {
                event.preventDefault();
                reportFileLinkFailure(`无法打开：${href ?? ""}`);
              }}
            >
              {children}
            </a>
          );
        }
        const { target } = link;
        return (
          <a
            {...props}
            href={href}
            title={target.line ? `${target.path}:${target.line}` : target.path}
            data-document-file-link={target.path}
            onClick={(event) => open(event, target)}
          >
            {children}
          </a>
        );
      },
    }),
    [documentPath, open, rootId],
  );
}
