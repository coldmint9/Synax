import { createContext, Suspense, useContext, useEffect, useState, type ReactNode } from "react";
import { useLocale } from "../../hooks/useLocale";

const PageActivity = createContext(true);
export function useWorkbenchPageActive(): boolean { return useContext(PageActivity); }
export function PageLoading() {
  const { t } = useLocale();
  return <div className="flex h-full min-h-0 items-center justify-center text-sm text-muted-foreground" role="status" aria-busy="true">{t("commonLoading")}</div>;
}

/** Mount on first visit, then retain drafts/selection when caching is allowed. */
export function CachedWorkbenchPage({ active, cache = true, children }: { active: boolean; cache?: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active);
  useEffect(() => { if (active) setVisited(true); else if (!cache) setVisited(false); }, [active, cache]);
  return <div className="absolute inset-0 flex flex-col" style={{ display: active ? undefined : "none" }} aria-hidden={!active}>
    <PageActivity.Provider value={active}>
      {(active || (cache && visited)) && <Suspense fallback={<PageLoading />}>{children}</Suspense>}
    </PageActivity.Provider>
  </div>;
}
