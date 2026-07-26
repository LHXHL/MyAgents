# Third-Party Notices

MyAgents 包含或与第三方软件、SDK、运行时、Skills、插件、素材及在线服务集成。下列内容不因
MyAgents 自有代码采用 `AGPL-3.0-only` 而改变许可证，也不自动包含在 MyAgents 商业许可证中。

## 主要独立组件

| 组件 | 许可证或条款 |
|---|---|
| Anthropic Claude Agent SDK 及其 native binary | Anthropic applicable legal agreements；参见随 SDK 提供的 `LICENSE.md` |
| Node.js 与 npm | Node.js、npm 及其所含第三方组件各自的许可证 |
| OpenClaw Plugin SDK 派生 shim | MIT License，Copyright © 2026 OpenClaw Foundation |
| Cuse binary | Apache License 2.0 |
| OpenAI Codex runtime | Apache License 2.0 |
| sharp | Apache License 2.0 |
| libvips（由 sharp 平台包携带） | LGPL-3.0-or-later |
| SheetJS `xlsx` | Apache License 2.0 |
| Tauri、React 及其他 npm/Cargo 依赖 | 各包声明的许可证 |
| 用户安装的 Skills、Plugins、MCP servers 与外部 Runtime | 各发布者声明的许可证或服务条款 |

随源码树提供独立 `LICENSE`/`LICENSE.txt`/`NOTICE` 的目录继续以这些文件为准。构建产物中
Node.js、npm、sharp runtime、SDK、Skills、Plugin Bridge shim 和其他资源所附许可证文件也
必须原样保留。

MyAgents 还可以连接 Anthropic、OpenAI、Google、飞书、钉钉、Telegram、企业微信及其他
第三方平台。MyAgents 许可证不提供这些平台的账号、API、模型、数据、服务或商标权。

本清单用于说明主要边界，不取代每次发行时根据 lockfile、目标平台和最终安装包生成的完整
软件物料清单（SBOM）及许可证审计。
