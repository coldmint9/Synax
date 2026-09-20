import { useEffect, useState } from "react";
import { useLocale } from "../../../../hooks/useLocale";
import {
  notifyProviderMetricsChanged,
  providerMetricsApi,
} from "../../../../lib/api/providerMetrics";
import { ExtensionMetrics } from "../../../components/extension-metrics/ExtensionMetrics";
import { useProviderMetrics } from "../../../components/extension-metrics/useProviderMetrics";
import type { ApiProviderDraft } from "../lib/providerPresets";

export function ProviderMetricsSettings({
  draft,
  revision = 0,
}: {
  draft: ApiProviderDraft;
  revision?: number;
}) {
  const { locale } = useLocale();
  const metrics = useProviderMetrics({ providerId: draft.id });
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const { id, baseUrl, apiKey, apiKeyMasked, format } = draft;

  useEffect(() => {
    setSupported(null);
    setDiscoveryError(null);
    let validUrl = false;
    try {
      validUrl = ["http:", "https:"].includes(new URL(baseUrl).protocol);
    } catch {
      /* Incomplete draft. */
    }
    if (!validUrl || (!apiKey.trim() && !apiKeyMasked?.trim())) {
      setDiscovering(false);
      return;
    }
    const controller = new AbortController();
    setDiscovering(true);
    const timer = window.setTimeout(async () => {
      try {
        const result = await providerMetricsApi.discover(
          {
            providerId: id,
            baseUrl,
            apiKey: apiKey.trim() || undefined,
            format,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setSupported(result.supported);
        notifyProviderMetricsChanged(id);
      } catch (error) {
        if (!controller.signal.aborted)
          setDiscoveryError(
            error instanceof Error ? error.message : "Discovery failed",
          );
      } finally {
        if (!controller.signal.aborted) setDiscovering(false);
      }
    }, 500);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [id, baseUrl, apiKey, apiKeyMasked, format, revision, refreshRevision]);

  return (
    <div className="space-y-1.5">
      <ExtensionMetrics
        configuration
        fields={metrics.fields}
        loading={metrics.loading || discovering}
        error={discoveryError || metrics.error}
        pending={metrics.pending}
        onUpdate={metrics.update}
        onRefresh={() => {
          void metrics.refresh();
          setRefreshRevision((value) => value + 1);
        }}
      />
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        {supported === false
          ? locale === "zh"
            ? "此供应商未声明参数；后续请求返回的扩展字段仍会自动发现。"
            : "This provider does not declare metrics; extension fields in future responses are still discovered automatically."
          : locale === "zh"
            ? "自动读取供应商参数声明，不会为发现参数额外调用模型。"
            : "Reads provider metric declarations without making an extra model request."}
      </p>
    </div>
  );
}
