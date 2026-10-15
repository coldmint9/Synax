import { useCallback, useEffect, useRef, useState } from "react";

type CacheEntry<T> = {
  value?: T;
  updatedAt: number;
  promise?: Promise<T>;
};

const resourceCache = new Map<string, CacheEntry<unknown>>();
const MAX_CACHE_ENTRIES = 128;

function trimCache(): void {
  if (resourceCache.size <= MAX_CACHE_ENTRIES) return;
  const candidates = [...resourceCache.entries()]
    .filter(([, entry]) => !entry.promise)
    .sort(([, left], [, right]) => left.updatedAt - right.updatedAt);
  for (const [key] of candidates) {
    if (resourceCache.size <= MAX_CACHE_ENTRIES) break;
    resourceCache.delete(key);
  }
}

export function readStaleResource<T>(key: string): T | undefined {
  return resourceCache.get(key)?.value as T | undefined;
}

export function writeStaleResource<T>(key: string, value: T): void {
  const current = resourceCache.get(key);
  resourceCache.set(key, {
    value,
    updatedAt: Date.now(),
    promise: current?.promise as Promise<T> | undefined,
  });
  trimCache();
}

export function invalidateStaleResource(key: string): void {
  const current = resourceCache.get(key);
  if (current?.promise) {
    resourceCache.set(key, { updatedAt: 0, promise: current.promise });
  } else {
    resourceCache.delete(key);
  }
}

export function clearStaleResourceCache(): void {
  resourceCache.clear();
}

export function fetchStaleResource<T>(
  key: string,
  loader: () => Promise<T>,
): Promise<T> {
  const current = resourceCache.get(key) as CacheEntry<T> | undefined;
  if (current?.promise) return current.promise;

  const promise = Promise.resolve()
    .then(loader)
    .then((value) => {
      const latest = resourceCache.get(key) as CacheEntry<T> | undefined;
      resourceCache.set(key, {
        value,
        updatedAt: Date.now(),
        promise: latest?.promise === promise ? undefined : latest?.promise,
      });
      trimCache();
      return value;
    })
    .finally(() => {
      const latest = resourceCache.get(key) as CacheEntry<T> | undefined;
      if (latest?.promise === promise) {
        resourceCache.set(key, { ...latest, promise: undefined });
      }
    });

  resourceCache.set(key, {
    value: current?.value,
    updatedAt: current?.updatedAt ?? 0,
    promise,
  });
  return promise;
}

export function useStaleResource<T>(
  key: string,
  loader: () => Promise<T>,
  enabled = true,
) {
  const [data, setData] = useState<T | undefined>(() => readStaleResource<T>(key));
  const [loading, setLoading] = useState(() => readStaleResource<T>(key) === undefined);
  const [refreshing, setRefreshing] = useState(() => readStaleResource<T>(key) !== undefined);
  const [error, setError] = useState<unknown>(null);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const id = ++requestId.current;
    const cached = readStaleResource<T>(key);
    setData(cached);
    setLoading(cached === undefined);
    setRefreshing(cached !== undefined);
    setError(null);
    try {
      const next = await fetchStaleResource(key, loader);
      if (id !== requestId.current) return;
      setData(next);
    } catch (cause) {
      if (id === requestId.current) setError(cause);
    } finally {
      if (id === requestId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [enabled, key, loader]);

  useEffect(() => {
    void refresh();
    return () => {
      requestId.current++;
    };
  }, [refresh]);

  return { data, loading, refreshing, error, refresh };
}
