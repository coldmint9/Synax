import { EMBEDDING_BASE_URL } from '../../lib/env.js';

export const DEFAULT_EMBEDDING_BASE_URL = EMBEDDING_BASE_URL;

export interface EmbeddingClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export class EmbeddingClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: EmbeddingClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_EMBEDDING_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return false;
      const body = (await res.json()) as { status?: string };
      return body.status === 'ok';
    } catch {
      return false;
    }
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/embedding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`embedding failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    return extractEmbedding(await res.json());
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

function flattenEmbedding(raw: number[] | number[][]): number[] {
  if (raw.length > 0 && Array.isArray(raw[0])) {
    return raw[0] as number[];
  }
  return raw as number[];
}

/** 兼容 llama.cpp /embedding 与 OpenAI /v1/embeddings 两种响应格式 */
export function extractEmbedding(payload: unknown): number[] {
  if (Array.isArray(payload)) {
    const first = payload[0] as { embedding?: number[] | number[][] };
    if (!first?.embedding) throw new Error('无法解析 embedding 数组响应');
    return flattenEmbedding(first.embedding);
  }
  if (payload && typeof payload === 'object') {
    const obj = payload as {
      data?: Array<{ embedding?: number[] | number[][] }>;
      embedding?: number[] | number[][];
    };
    if (obj.data?.[0]?.embedding) return flattenEmbedding(obj.data[0].embedding);
    if (obj.embedding) return flattenEmbedding(obj.embedding);
  }
  throw new Error(`无法解析 embedding 响应: ${JSON.stringify(payload).slice(0, 120)}`);
}
