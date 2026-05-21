// ---------------------------------------------------------------------------
// api/services/context/sync-bus.ts
//
// 内部事件总线：解耦写入路径和下游订阅者（SSE 推送、遥测、缓存失效等）。
// 基于 node:events 的 EventEmitter，按 projectId 投递，避免跨项目串扰。
// ---------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import type { SyncEvent } from '../contracts/context.js';

class SyncBus {
  private emitter = new EventEmitter();

  constructor() {
    // 解除默认的 10 监听上限：多标签页/多订阅端常见
    this.emitter.setMaxListeners(0);
  }

  /** 发射一条同步事件（按 projectId 广播 + 全局广播）。 */
  emit(event: SyncEvent): void {
    this.emitter.emit(`project:${event.projectId}`, event);
    this.emitter.emit('*', event);
  }

  /**
   * 订阅某个项目的同步事件。
   * @returns 取消订阅函数
   */
  subscribe(projectId: string, handler: (event: SyncEvent) => void): () => void {
    const channel = `project:${projectId}`;
    this.emitter.on(channel, handler);
    return () => {
      this.emitter.off(channel, handler);
    };
  }

  /** 订阅所有项目事件（用于遥测/调试）。 */
  subscribeAll(handler: (event: SyncEvent) => void): () => void {
    this.emitter.on('*', handler);
    return () => {
      this.emitter.off('*', handler);
    };
  }
}

export const syncBus = new SyncBus();
export type { SyncBus };
