import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';

/** 读取环境变量，支持默认值 */
export function env(key: string, fallback?: string): string {
  return process.env[key] ?? fallback ?? '';
}

/** 服务监听端口 */
export const PORT = Number(env('PORT', '3210'));

/** 运行环境 */
export const NODE_ENV = env('NODE_ENV', 'development');

/** 日志级别 */
export const LOG_LEVEL = env('LOG_LEVEL', 'info');

function defaultDataRoot(): string {
  if (NODE_ENV === 'test' || process.env.VITEST_WORKER_ID || process.env.VITEST) {
    return path.join(os.tmpdir(), `Synax-vitest-${process.env.VITEST_WORKER_ID ?? 'worker'}-${process.pid}`);
  }
  return path.join(os.homedir(), '.synax');
}

/** 数据根目录，统一存放于 ~/.synax */
export const DATA_ROOT = env('DATA_ROOT', defaultDataRoot());

/** 是否为开发环境 */
export const isDev = NODE_ENV === 'development';

/** 上下文会话 TTL（小时），SessionManager 用于判定过期 */
export const CONTEXT_SESSION_TTL_HOURS = Number(env('CONTEXT_SESSION_TTL_HOURS', '72'));

/** 单会话 token 预警阈值（到达则发出 session_token_warning） */
export const CONTEXT_TOKEN_WARNING_THRESHOLD = Number(
  env('CONTEXT_TOKEN_WARNING_THRESHOLD', '32000'),
);

/** 单项目记忆条目上限（超限进行 LRU 淘汰） */
export const CONTEXT_MEMORY_MAX_PER_PROJECT = Number(
  env('CONTEXT_MEMORY_MAX_PER_PROJECT', '500'),
);

/** 确定性工具结果清除：触发阈值（占 contextLimit 的比例） */
export const CONTEXT_TOOL_CLEAR_THRESHOLD = Number(env('CONTEXT_TOOL_CLEAR_THRESHOLD', '0.5'));

/** 确定性工具结果清除：保留最近 N 个完整结果 */
export const CONTEXT_TOOL_CLEAR_KEEP_RECENT = Number(env('CONTEXT_TOOL_CLEAR_KEEP_RECENT', '3'));

/** 确定性工具结果清除：排除的工具 ID（逗号分隔） */
export const CONTEXT_TOOL_CLEAR_EXCLUDE = env('CONTEXT_TOOL_CLEAR_EXCLUDE', 'task.create,task.update,task.get,task.list').split(',');

/** Wiki Phase 1: use the fast single-call outline generator (falls back to agent planner on failure) */
export const WIKI_FAST_INIT = env('WIKI_FAST_INIT', 'true') !== 'false';

/** Wiki Phase 2: max document-writer agents in flight */
export const WIKI_WRITE_CONCURRENCY = Number(env('WIKI_WRITE_CONCURRENCY', '5'));

/** Wiki Phase 2: max verifier/corrector agents in flight */
export const WIKI_VERIFY_CONCURRENCY = Number(env('WIKI_VERIFY_CONCURRENCY', '3'));
