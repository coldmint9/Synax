import { apiFetch } from "./origin";

export interface WslDistribution {
  name: string;
  version: 2;
  default: boolean;
  state?: string;
}

export interface WslCapabilities {
  available: boolean;
  reason?: string;
  items: WslDistribution[];
}

export async function listWslDistributions(): Promise<WslCapabilities> {
  const response = await apiFetch("/api/wsl/distributions");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<WslCapabilities>;
}
