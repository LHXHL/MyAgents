---
type: prd
status: approved-for-implementation
created: 2026-09-26
updated: 2026-09-26
scope: MyAgents build-time DSH version choice and MyAgents-dsh GitHub Release consumption
---

# MyAgents 构建时选择 MyAgents-dsh 版本

Producer 需求与技术方案分别见 [MyAgents-dsh Release PRD](../../../MyAgents-dsh/specs/prd/prd_0.3_release_delivery.md) 和 [Release RFC](../../../MyAgents-dsh/specs/prd/tech_rfc_0.3_release_delivery.md)。本文是 MyAgents 侧的需求与验收边界；现有构建实现见 [构建资源技术文档](../tech_docs/build_resource_preparation.md)。

## 1. 问题与结果

DSH 与 MyAgents 独立开发、独立发布。DSH Runtime 更新低频，客户端业务更新高频。客户端应该能为自己的某个版本**只选择一个 DSH 版本号**，以后每次 Dev/Release 打包都自动取得那个版本的目标平台资源。不同客户端版本可选择不同 DSH 版本。客户端不需要因 DSH 一次发行再手工录入四个平台的文件名、源码提交和摘要，也不在用户启动时选择或下载 Runtime。

旧设计让 `prepare-dsh-runtime.mjs` 要求 committed `release.sourceCommit` 与 `release.assets[target]`，把 producer 的资产表复制进 consumer。现已改为 MyAgents 仅提交版本选择；资产表由 DSH 对应版本的 Release `manifest.json` 唯一维护。`v0.1.0` 尚无公开 Release，因此当前默认构建失败是预期现状。

## 2. Owner 与版本路径

| 事实 | Owner |
| --- | --- |
| 版本号、tag、各平台包、源码提交、摘要、原生证据、Release 清单 | MyAgents-dsh |
| 客户端当前选择哪个 DSH 版本 | MyAgents 中唯一的发行版本配置 |
| 当前构建的 target、下载/缓存、字节校验、Node/协议/Host 契约检查 | MyAgents 构建准备入口 |
| 打入 App 的实际 DSH 身份 | 从已验证 handoff 派生的 effective lock，供 TS/Rust/App 同时读取 |
| 已存在 Session 使用哪个 Runtime | 既有 Session binding；不随版本配置变化热切换 |

MyAgents 填 `0.1.0`，构建脚本派生 `v0.1.0` 并访问固定 URL：

`https://github.com/hAcKlyc/MyAgents-dsh/releases/download/v0.1.0/manifest.json`

清单是 DSH 发布工作流上传的 GitHub Release 资产，包含四个平台的完整记录；不是 GitHub 自动生成的文件。脚本按本次**构建目标**选择平台，用同一 tag 下的包名拼出下载 URL，并按清单校验大小、archive SHA、handoff SHA、Runtime/兼容性摘要及共同 source commit。不能用构建主机架构推测目标。没有 `latest` 索引，也不需要 R2；Release 不存在、清单未公开或不完整时构建失败。

MyAgents 的唯一发行选择文件定为 `src/shared/integrated-runtimes/dsh-release.json`，仅含 `{ "version": "0.1.0" }`。不再提交第二份每平台资产表。Producer 负责保证公开版本完整且不可变；consumer 仍负责确认下载字节与 producer 清单一致，并确认该 DSH 版本满足**当前 MyAgents 源码**的协议 client、Host 契约、目标 native addon 与 bundled Node/npm。这些是消费检查，不是对资源清单的重复 ownership。成功构建记录本次实际版本和摘要，供诊断和运行时 binding 派生。

## 3. 构建入口与本地联调

| 入口 | 默认来源 | 显式覆盖 |
| --- | --- | --- |
| macOS/Windows/Linux 正式打包、直接生产 Tauri build | 已配置版本的 GitHub Release | 不允许 local |
| macOS/Windows/Linux packaged Dev | 同一已配置版本的 GitHub Release | `local` + 官方 handoff 绝对路径 |

本地联调覆盖必须显式传 `--dsh-source local --dsh-handoff /absolute/path`，Windows 用对应 PowerShell 参数。它只影响**本次构建**，不修改提交的版本选择，不自动寻找 sibling DSH checkout，也不接受裸源码或临时拼出的 Runtime 子目录。新 DSH 代码须先经官方 builder 产生 handoff。local 和 release 都运行公共 handoff verifier、Host 契约检查和原子 staging；Release 失败绝不改走 local 或旧资源。

当前顶层 `dsh-lock.json` 的非发行字段如仍用于未准备的 source-mode 开发或旧测试，只是历史/开发身份快照。它的 `release` 资产选择已移除，不让旧快照成为发布清单的第二 authority。本次生成的 effective lock 与 compatibility 是 ignored 的构建输出，在 Renderer、Sidecar、Rust `build.rs` 和最终 App 中一致；local 路径不进入产品数据。

## 4. 失败与缓存

- 每次构建先固定选择版本和 target。已缓存清单只能属于该版本；archive 缓存按清单 SHA 寻址。缓存命中仍验证字节、handoff 和兼容性，损坏则重新获取，不以文件存在代表正确。
- 网络不可用、缺清单或包、版本/source/目标不一致、错 SHA、无对应原生模块、Runtime verifier 失败、Node/npm 或 Host 协议不兼容，均在 Tauri 打包前给出具体错误。失败可保留先前已验证缓存和 staged 目录，但不能将其标记为**本次成功构建**。
- 同一已公开版本的字节由 DSH Release 保证不可变；修正需要 DSH 发布新版本，MyAgents 只改版本号并重建。客户端自己的历史版本仍可绑定旧版 DSH。
- 用户运行 App 时不访问 GitHub、不检查 latest、不替换 Runtime；已有 Session 的绑定保持原身份。

## 5. 验收

1. 提交的 DSH 发行选择只有版本号；将 `0.1.0` 改为未来 `0.1.1` 不要求改四个平台 SHA 表或复制源码提交。
2. 同一版本的 Dev 默认与 Release 构建取得同一目标资产；显式 local handoff 仅用于 Dev，且不污染以后默认构建。
3. macOS ARM/Intel、Windows x64、Linux x64 干净构建分别从固定版本清单选到正确原生包。至少一个真实端到端客户端包读取并验证该版本，其余目标由对应 runner 验收。
4. 版本 URL、清单 schema/完整性、目标选择、缓存损坏、下载失败、不兼容契约、旧 staged 不回退和 effective identity parity 有隔离回归测试。
5. `v0.1.0` 尚未发布时，默认构建清楚失败；显式 local handoff 仍可供联合开发。DSH 发布并通过四目标验收后，客户端无需填写额外摘要即可构建。

## 6. 非目标与当前状态

不引入客户端 DSH 更新器、运行时下载、R2、`latest.json`、自动修改 MyAgents 版本、任意 DSH 版本自动兼容的承诺。当前已存在的本地 Dev 覆盖与 effective lock 生成路径应复用，不另建第二条资源准备入口。

2026-09-26：MyAgents 已用 `dsh-release.json` 单独选择版本、读取生产者的九资产清单并派生有效身份；MyAgents-dsh 已接入 tag 四平台构建及发布工作流。当前还没有公开的 `v0.1.0` Release，也没有真实四平台 Actions / 客户端消费验收；因此默认构建会在下载清单时失败，显式 local handoff 可继续供联调。
