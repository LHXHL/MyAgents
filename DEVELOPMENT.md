# MyAgents 开发指引

[返回 README](README.md) · [English](#english) · [贡献指南](CONTRIBUTING.md)

MyAgents 使用 Tauri v2 + Rust、React 19 + TypeScript，以及 Node.js v24 Sidecar。Agent Runtime 包括 Claude Agent SDK、Integrated DeepSeek Harness 和 Claude Code / Codex 适配。具体模块职责与边界以[架构文档](specs/ARCHITECTURE.md)为准。

## 环境准备

- Node.js `>=24.14.0`、npm `>=11.15.0`，版本约束见 [package.json](package.json)，推荐 Node 版本见 [.nvmrc](.nvmrc)。
- 通过 rustup 安装 Rust；实际工具链由 [rust-toolchain.toml](rust-toolchain.toml) 固定。
- 原生推理资源冷构建需要 CMake 3.28+ 和平台 C/C++ 工具链。macOS 还需要 Git、Python 3.10+ 与 Apple Clang；Windows 需要 MSVC 构建工具。
- macOS 13+（Apple Silicon / Intel）与 Windows 10+ x64 的平台步骤见下文。Linux 当前构建目标为 Ubuntu 24.04 x64，具体限制与验收要求见 [Linux 指南](specs/guides/linux_build_guide.md)。

开发工具链与应用内置运行时独立。安装版用户无需安装系统 Node；打包的 Node/npm 版本由 [scripts/node-runtime.json](scripts/node-runtime.json) 固定。

## 本地开发与构建

先克隆本仓库，贡献代码时可替换为自己的 fork：

```bash
git clone https://github.com/hAcKlyc/MyAgents.git
cd MyAgents
```

macOS：

```bash
./setup.sh
./start_dev.sh
```

Windows PowerShell：

```powershell
.\setup_windows.ps1
.\build_windows.ps1
```

Ubuntu 24.04 x64：

```bash
./setup.sh
./build_dev_linux.sh
```

setup 会按 target 与已验证缓存检查原生构建工具，然后准备 Node、依赖和文档/语音推理资源；重复运行会复用匹配的资源缓存。Linux 系统依赖通过 apt 安装，需要相应权限。详细行为与平台差异见[构建资源准备与复用](specs/tech_docs/build_resource_preparation.md)。内置 Mino 工作区模板在 `bundled-workspaces/mino/`，初始化无需额外的 GitHub SSH 或模板下载。

| 目标 | 入口与说明 |
| --- | --- |
| macOS Debug 构建 | `./build_dev.sh` |
| macOS 生产构建 | `./build_macos.sh`，见[构建与发布指南](specs/guides/build_and_release_guide.md) |
| Windows 构建 | `./build_windows.ps1`，见 [Windows 指南](specs/guides/windows_build_guide.md) |
| Linux Debug 构建 | `./build_dev_linux.sh`，无桌面启动时用 `--build-only` |
| Linux `.deb` 构建 | `./build_linux.sh`，见 [Linux 指南](specs/guides/linux_build_guide.md) |
| 构建问题排查 | [排错指南](specs/guides/build_troubleshooting.md) |

Linux 构建入口不代表该版本已经完成发布验收；可下载版本以 Releases 为准。

## 检查与测试

按改动影响面选择检查；纯文档改动不要求代码测试。实际命令以 [package.json](package.json) 为准。

```bash
npm run typecheck           # TypeScript
npm run lint                # ESLint、依赖边界与 Agent 文档检查
npm run test:classification # 测试命名与分层
npm run test:build-scripts  # 构建脚本
npm run test:unit           # 纯逻辑
npm run test:dom            # React / jsdom
npm run test:integration    # CI-safe 后端集成，无真实服务密钥
npm test                   # 以上五个测试池
npm run test:credentialed   # 真实 Provider / SDK smoke，仅显式本地运行
```

## 项目与文档导航

```text
src/renderer/              React 前端
src/server/                Node.js Sidecar 与 SessionEngine
src/server/plugin-bridge/  OpenClaw Plugin Bridge
src/cli/                   myagents CLI
src/shared/                共享类型与逻辑
src-tauri/                 Tauri Rust 桌面层与 Worker
bundled-agents/            内置 Agent
bundled-workspaces/        工作区模板
bundled-skills/            内置 Skills 与产品用法文档
specs/                     架构、设计、技术与构建文档
```

涉及 Session、Runtime、MCP、Task、网络或插件时，请先读相应 owner 文档，避免在不同模块复制状态或绕过已有入口。

- [架构总览](specs/ARCHITECTURE.md) · [Session 架构](specs/tech_docs/session_architecture.md) · [Sidecar 冷启动](specs/tech_docs/sidecar_cold_start.md)
- [多 Runtime](specs/tech_docs/multi_agent_runtime.md) · [任务中心](specs/tech_docs/task_center.md) · [CLI](specs/tech_docs/cli_architecture.md)
- [AgentNet](specs/tech_docs/agent_network.md) · [Space](specs/tech_docs/space_cloud.md) · [Plugin Bridge](specs/tech_docs/plugin_bridge_architecture.md)
- [MCP 与架构护栏](specs/tech_docs/pit_of_success.md) · [设计系统](specs/DESIGN.md)
- [Cuse 集成与构建](specs/tech_docs/cuse_bundle.md)：可选全局 Skill + CLI，更新维护内容并保留用户的禁用设置。

提交约定与贡献许可见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

<a id="english"></a>

## English

MyAgents uses Tauri v2 + Rust, React 19 + TypeScript, and a Node.js v24 Sidecar. Runtimes include Claude Agent SDK, Integrated DeepSeek Harness, and Claude Code / Codex adapters. The [architecture guide](specs/ARCHITECTURE.md) defines module responsibilities and boundaries.

### Prerequisites

- Node.js `>=24.14.0` and npm `>=11.15.0`; see [package.json](package.json) and [.nvmrc](.nvmrc).
- Rust installed with rustup, using the toolchain pinned in [rust-toolchain.toml](rust-toolchain.toml).
- CMake 3.28+ and a platform C/C++ toolchain for cold native inference builds. macOS also needs Git, Python 3.10+, and Apple Clang; Windows needs MSVC build tools.
- macOS 13+ (Apple Silicon / Intel), Windows 10+ x64, or the current Linux build target, Ubuntu 24.04 x64.

The app bundles Node/npm independently of the development toolchain; its versions are pinned in [scripts/node-runtime.json](scripts/node-runtime.json). End users do not need system Node.

### Setup and builds

Clone the repository or your fork, then use the appropriate entry points:

| Platform | Setup | Development | Release build |
| --- | --- | --- | --- |
| macOS | `./setup.sh` | `./start_dev.sh` or `./build_dev.sh` | `./build_macos.sh` |
| Windows PowerShell | `.\setup_windows.ps1` | `.\build_windows.ps1` | See the Windows guide for packaging options |
| Ubuntu 24.04 x64 | `./setup.sh` | `./build_dev_linux.sh` | `./build_linux.sh` (`.deb`) |

Setup checks native tools for the target and prepares dependencies and document/speech resources, reusing verified caches. Linux system packages are installed through apt and require appropriate permissions. The Mino template is included in `bundled-workspaces/mino/`; it does not require a separate template download or GitHub SSH access.

Platform details: [macOS and release guide](specs/guides/build_and_release_guide.md) · [Windows](specs/guides/windows_build_guide.md) · [Linux](specs/guides/linux_build_guide.md) · [Troubleshooting](specs/guides/build_troubleshooting.md) · [Resource preparation](specs/tech_docs/build_resource_preparation.md). These detailed guides are maintained in Chinese. A Linux build entry point does not imply that a particular version has passed release acceptance; check Releases for available packages.

### Checks and architecture

Choose checks that match the change. Use `npm run typecheck` and `npm run lint` for code checks. The test pools are `test:classification`, `test:build-scripts`, `test:unit`, `test:dom`, and `test:integration`; `npm test` runs all five. Real-provider smoke tests use `test:credentialed` and must be run explicitly with local credentials. Documentation-only changes do not require code tests.

The main source areas are `src/renderer/` (UI), `src/server/` (Sidecar and SessionEngine), `src/cli/`, `src/shared/`, and `src-tauri/` (desktop shell and Workers). Bundled Agents, workspaces, and Skills live in their respective `bundled-*` directories. Read the [architecture](specs/ARCHITECTURE.md) and relevant module documents linked above before changing process, session, runtime, task, network, or plugin boundaries.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution steps and terms.
