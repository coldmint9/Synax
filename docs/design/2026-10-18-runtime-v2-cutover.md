# Runtime 2.0 硬切换进度

用户目标：剔除旧运行时，将数据迁到 Rust runtime，跑通最小 E2E，统一版本为 2.0.0。此目标取代旧的双写/兼容方案。当前尚未完成，不应合并发布或标记 goal complete。

## 本轮实际改动

- `.env.version` 为 2.0.0；`version:sync` 同步 Node、client、lockfile、代码版本及 Rust Cargo 包版本。
- HTTP history 仅保留已有 Rust 路径；删除 flat/versioned/JSONL 动态加载与 runtime 模式选择。删除在线 history upgrade 入口和 client adapter。history recover 调用 Rust outbox reconcile。
- RuntimeFacade 移除 shadow admission/append/completion 与整库 SQL history 补写方法。部分方法仍读取中央 session-store，不能据此宣称整个依赖图已脱离 SQL。
- RuntimeStreamWriter 不再读取 SQL history epoch 或写 Node journal。它按当前流生成中断回复并等待 Rust 提交。
- RuntimeJournal 删除同步内存 append/read/snapshot 与独立 replay 数据源；保留 Rust 异步日志适配和通知等待。
- Rust history 删除全局旧索引 fallback，只从当前 head 的可达图查询实体。未发布对象不进入会话历史。
- 离线迁移从旧表解码为原生 runtime 实体，导入 permission/interaction control state，并验证实体字段；迁移 smoke 验证导入、追加新一轮、删除已迁移的 SQL 表后重启读回。

## 证据与范围

- `npm run typecheck` 通过。
- `npm run runtime-sidecar:test -- --locked`：73 项通过。
- 六个定向 Vitest 文件：26 项通过。旧 Node 内存 journal 专用测试已被 Rust adapter 测试替换；旧 SQLite checkpoint 测试中的 Node journal 断言已删除。
- `node --import tsx/esm scripts/runtime-migration-smoke.ts` 通过：测试的是隔离数据目录，不是用户实际数据迁移。
- `node --import tsx/esm scripts/runtime-v2-main-path-e2e.ts` **失败**，但前四步通过：真实 HTTP session create → submit → 独立 provider worker → Rust completion → 原生 WebSocket → host restart → HTTP history。最后 `no old runtime SQL tables` 断言失败，旧 agent_runtime/conversation/jsonl/transcript 表仍存在。
- E2E 使用确定性的本地 HTTP provider fixture；没有将其声称为外部模型验收，也没有绕过生产 create/submit 入口。
- E2E 输出：`out/runtime-v2-e2e/result.json` 和 `host.log`。失败时保留隔离 DATA_ROOT，便于定位。
- 未重新跑旧 1.x 全量测试，不沿用之前 2999 项通过作为 2.0 的验收证据。

## 下一节点（必须继续开发）

1. 用 Rust repository 替换中央 `session-store.ts` 的 SQL 实现；显式加载会话、await 提交。删除 create seed/mirror 的隐式 SQL 依赖。
2. 将 coordinator/admission/worker、work/context/plan/permission/interaction 等调用接到新仓储；删除旧 checkpoint/JSONL/flat 实现及仅验证旧后端的测试，保留原产品行为在 Rust 主路径的验收。
3. 停止在线 database migration 创建 runtime SQL 表，移除旧 bootstrap/history retention 和 runtime flags。不能仅在 E2E 结束时 DROP 表让检查变绿。
4. 完成实际数据来源摸排和迁移。目前离线导出覆盖常规 runtime SQL 行；旧 versioned/JSONL payload、附件、terminal 等数据仍须完整导入后，才能对用户数据执行最终清理。
5. 重新执行最小 E2E，要求业务步骤及“零旧 runtime SQL 表”全部通过，再做 2.0 DMG 和最终发布验收。
