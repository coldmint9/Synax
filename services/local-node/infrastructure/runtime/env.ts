import "dotenv/config";
import os from "node:os";
import path from "node:path";

/** 读取环境变量，支持默认值 */
export function env(key: string, fallback?: string): string {
  return process.env[key] ?? fallback ?? "";
}

/** 服务监听端口 */
export const PORT = Number(env("PORT", "3210"));

/** 运行环境 */
export const NODE_ENV = env("NODE_ENV", "development");

/** 日志级别 */
export const LOG_LEVEL = env("LOG_LEVEL", "info");

function defaultDataRoot(): string {
  if (
    NODE_ENV === "test" ||
    process.env.VITEST_WORKER_ID ||
    process.env.VITEST
  ) {
    return path.join(
      os.tmpdir(),
      `Synax-vitest-${process.env.VITEST_WORKER_ID ?? "worker"}-${process.pid}`,
    );
  }
  return path.join(os.homedir(), ".synax");
}

/** 数据根目录，统一存放于 ~/.synax */
export const DATA_ROOT = env("DATA_ROOT", defaultDataRoot());

/** 是否为开发环境 */
export const isDev = NODE_ENV === "development";

/** 上下文会话 TTL（小时），SessionManager 用于判定过期 */
export const CONTEXT_SESSION_TTL_HOURS = Number(
  env("CONTEXT_SESSION_TTL_HOURS", "72"),
);

/** 单会话 token 预警阈值（到达则发出 session_token_warning） */
export const CONTEXT_TOKEN_WARNING_THRESHOLD = Number(
  env("CONTEXT_TOKEN_WARNING_THRESHOLD", "32000"),
);

/** 单项目记忆条目上限（超限进行 LRU 淘汰） */
export const CONTEXT_MEMORY_MAX_PER_PROJECT = Number(
  env("CONTEXT_MEMORY_MAX_PER_PROJECT", "500"),
);

/** 确定性工具结果清除：高水位阈值（占 contextLimit 的比例） */
export const CONTEXT_TOOL_CLEAR_THRESHOLD = Number(
  env("CONTEXT_TOOL_CLEAR_THRESHOLD", "0.8"),
);

/** 确定性工具结果清除：保留最近 N 个完整结果 */
export const CONTEXT_TOOL_CLEAR_KEEP_RECENT = Number(
  env("CONTEXT_TOOL_CLEAR_KEEP_RECENT", "3"),
);

/** 确定性工具结果清除：排除的工具 ID（逗号分隔） */
export const CONTEXT_TOOL_CLEAR_EXCLUDE = env(
  "CONTEXT_TOOL_CLEAR_EXCLUDE",
  "task.create,task.update,task.get,task.list",
).split(",");




/** Auto-reject permission requests after this duration (ms). Default 10 min. */
export const PERMISSION_TIMEOUT_MS = Number(
  env("PERMISSION_TIMEOUT_MS", "600000"),
);

/** Max concurrent root agent session child processes. */
export const MAX_AGENT_SESSION_PROCESSES = Number(
  env("MAX_AGENT_SESSION_PROCESSES", "8"),
);

/**
 * Agent sessions run inside the host process by default, so context.db keeps a
 * single writer and concurrent sessions cannot raise SQLITE_BUSY against each
 * other. Set SYNAX_AGENT_SESSION_IN_PROCESS=0 to restore forked
 * agent-session-runner workers: per-session process isolation, at the cost of
 * N+1 processes writing the same database file.
 */
export function agentSessionsRunInProcess(): boolean {
  const explicit = process.env.SYNAX_AGENT_SESSION_IN_PROCESS;
  if (explicit === "1") return true;
  if (explicit === "0") return false;
  return (
    process.env.SYNAX_AGENT_SESSION_CHILD !== "1"
  );
}

/** Max concurrent long-lived ACP (local agent runtime) session connections. */
export const MAX_ACP_SESSIONS = Number(env("MAX_ACP_SESSIONS", "8"));

/** Idle timeout before recycling an ACP session child process (ms). Default 30 min. */
export const ACP_SESSION_IDLE_TIMEOUT_MS = Number(
  env("ACP_SESSION_IDLE_TIMEOUT_MS", "1800000"),
);

/** Agent session child ready handshake timeout (ms). */
export const AGENT_SESSION_CHILD_READY_TIMEOUT_MS = Number(
  env("AGENT_SESSION_CHILD_READY_TIMEOUT_MS", "30000"),
);

/** LLM 流式空闲看门狗默认值（ms）：流式请求超过该时长未收到任何事件（含 raw 心跳）时，
 *  视为上游连接静默挂起，主动中断并按网络错误重试，避免会话永久卡在某个 step。 */
export const DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS = 300_000;

/** LLM 流式空闲看门狗（ms），读取环境变量 AGENT_LLM_STREAM_IDLE_TIMEOUT_MS。
 *  每次调用时读取以便运行/测试期调优；显式设为 0 表示禁用。 */
export function agentLlmStreamIdleTimeoutMs(): number {
  const raw = env("AGENT_LLM_STREAM_IDLE_TIMEOUT_MS", "");
  if (raw === "") return DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS;
}

/** 本地 LLM 令牌桶限流开关，读取环境变量 AGENT_LLM_RATE_LIMITER。
 *  默认关闭：本地按 provider/model 估算配额会在多会话/多 subagent 并发时把同一
 *  provider 的请求串行排队，造成会话长时间停滞；真实配额限制交由 provider 的
 *  429 响应与 retry middleware 处理。设为 on/1/true 可重新启用本地排队。
 *  每次调用时读取以便运行/测试期切换。 */
export function llmRateLimiterEnabled(): boolean {
  const raw = env("AGENT_LLM_RATE_LIMITER", "");
  if (raw === "") return false;
  return !["0", "false", "off"].includes(raw.trim().toLowerCase());
}


/** 本地 EmbeddingGemma (llama.cpp) 服务地址，供 tree-embedding-bench 原型使用 */
export const EMBEDDING_BASE_URL = env(
  "EMBEDDING_BASE_URL",
  "http://127.0.0.1:8080",
);
