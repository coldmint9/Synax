# SYNAX 项目管理细则

## 发布版本自动管理

- `main` 是生产发布分支；向 `main` 推送代码前，应汇总本次变更，并与上一个版本 Tag 对比。
- `.env.version` 中的 `SYNAX_VERSION` 是唯一版本源，`package.json`、lockfile 和代码中的版本号由脚本同步生成，不要手工分别修改。
- 漏洞修复执行 `npm run version:patch`，递增补丁版本号。
- 新增向下兼容功能执行 `npm run version:minor`，递增次版本号。
- 主版本号由作者自行维护：手动修改 `.env.version` 后执行 `npm run version:sync`。
- 版本号采用 `主版本号.次版本号.补丁版本号` 格式；主版本号用于不兼容的超大版本变更，次版本号用于向下兼容的功能更新，补丁版本号用于向下兼容的问题修复。
- `package.json` 不支持环境变量动态插值，因此它的版本号必须由脚本写入合法的静态 SemVer。
