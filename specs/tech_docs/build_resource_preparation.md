# 构建脚本与资源准备规范

## 定位与适用范围

本文是 setup、开发构建、正式构建及其资源准备 helper 的设计与维护规范。新增或修改这些脚本时必须遵循下述原则，并维护对应验证；后续章节说明当前实现如何落实这些原则。发布上传、自动更新和 App 运行时下载各自遵循所属模块的协议，不能直接套用构建下载策略。

当前命令、默认参数、版本和可执行行为以代码、配置与测试为准；本文负责解释职责边界、不变量和设计取舍。发现实现与规范不一致时，先核实代码与历史，再修复实现或更新已变更的设计，不能把旧实现偶然如此当成新脚本的范例。

- 操作步骤与平台依赖：[macOS 构建与发布](../guides/build_and_release_guide.md)、[Windows 构建](../guides/windows_build_guide.md)、[Linux 构建](../guides/linux_build_guide.md)。
- 资源专属约束：[内置 Node](bundled_node.md)、[Cuse](cuse_bundle.md)、[CLIProxy](managed_cliproxy.md)、[文档处理](document_processing.md)、[录音与语音](recording_and_speech_recognition.md)。

## 新增与修改脚本必须遵循的原则

1. **入口负责组织流程，资源 helper 负责资源是否可用。** setup 与 build 必须复用同一资源准备入口；平台脚本不得另写版本、缓存命中或补下载逻辑。平台入口须能补齐其声明负责的资源，不能依赖过去运行过另一个入口；直接调用底层工具的前置条件须在指南中明确。
2. **每项事实只有明确的权威来源。** 资源版本、目标架构、摘要与发布策略来自既有 lock、manifest 或配置。锁定版本与跟随 latest 是两种明确策略，不能因缓存或网络失败偷偷切换；新增资源必须先说明采用哪一种。
3. **按本次构建目标准备，区分 host 与 target。** 主机能力用于判断能否运行构建工具，目标参数用于选择交付资源。双架构和交叉构建不得沿用上次 staging 的架构；架构无关的业务产物在一次构建中只生成一次。
4. **校验后复用，让重复执行自然收敛。** 文件存在不等于就绪；必须按资源契约验证版本、平台、完整性、权限及必要的可执行能力。已有锁定摘要时必须核对摘要。命中缓存不能绕过验证，修复缺失或损坏资源不应要求清空所有缓存。
5. **原始缓存与可变打包副本分开。** 缓存保存可复用的已验证输入或准备结果，解包、签名及平台修饰落在独立 staging。不得因共享 inode 或原地改写污染缓存，也不能拿签名后的字节冒充上游原始 artifact。
6. **失败有边界，重跑有路径。** 直接资源下载使用已有公共下载策略，为请求及响应体设置时限，有限重试临时故障，并执行资源契约规定的大小与摘要校验；完整性或永久错误直接失败。下载半包不得成为正式资源，先在临时路径完成验证再交付。修改替换流程时必须说明失败后旧资源是否保留、如何恢复，不能把局部替换描述成整个构建的事务保证。
7. **副作用归属清楚。** prepare 不兼任发布上传、修改应用版本或安装系统依赖；系统环境安装由明确的 setup/install-deps 路径承担。资源锁只保护其声明的范围，不能据此假设同一个 checkout 可并行签名或打包。
8. **日志与验证服务于实际使用。** 日志说明检查、命中、缺失原因、下载尝试和失败阶段，不能把准备开始写成成功。新增故障路径用隔离测试固定，特别覆盖重复执行、缓存损坏、下载中断、目标切换和失败后的已有资源；真实网络与平台验收单独执行并注明限制。

应优先扩展下文的现有 helper。确需新 helper 时，说明现有实现为何不能承担该职责；不为单个资源重新建立一套下载、缓存或重试框架。可确定性检查的约束应落入测试或静态检查，文档保留其原因与使用入口。

## 当前入口职责

`setup.sh` / `setup_windows.ps1` 准备开发依赖与 host 资源；平台 build 脚本检查本次目标并准备安装包。不能把“以前运行过 setup”作为资源就绪依据。两类入口复用资源 helper，由 helper 校验版本、目标、完整性后决定复用或补齐。

Linux 的 setup 通过 `build_linux.sh --install-deps` 和 `--prepare` 复用资源路径，debug/release 也走该脚本。macOS/Windows 的开发版仍可使用项目 node_modules 提供 sharp/tsx；正式包必须携带自包含资源。

## 架构无关的业务产物只构建一次

`npm run build:assets` 是前端、Sidecar、Bridge、CLI 的组合入口，各 target 的细节仍属于既有 Vite / esbuild driver。

- 直接 `npm run tauri:build`：主配置的 `beforeBuildCommand` 调用 `build:assets`。
- macOS/Windows build：先成功运行 `build:assets`，再用**本次命令的配置覆盖**关闭钩子；不修改持久 Tauri 配置。macOS 双架构在 target loop 外构建一次，原生资源仍逐 target 准备。
- Linux build：沿用 Tauri 默认钩子，只执行一次。Linux `--prepare` 仅准备开发资源及 Node 业务 bundle，不生成前端发行包或 Rust 应用。

遗漏显式业务构建后关闭钩子会打包旧产物。`scripts/build-assets.test.mjs` 检查组合入口、失败短路、各平台调用次序以及默认钩子，`scripts/linux-package.test.mjs` 执行隔离的 Linux 入口流程。

## tsx / sharp 的缓存与打包副本

`setup-tsx-runtime.mjs` 与 `prepare-sharp-runtime.mjs` 使用 `npm-runtime-cache.mjs`。平台脚本不判断 cache、不维护另一份 sharp 版本表，也不自行安装 native 变体。

- 依赖 authority：根 `package.json` 的精确版本和 `package-lock.json` 中对应运行时的依赖闭包。保留 npm 的嵌套包布局，剥离仅用于项目开发分类的 dev 标记，使用隔离 lock 执行 `npm ci --ignore-scripts`。跨目标 optional dependencies 按 os/cpu/libc 选择，避免运行目标架构的 postinstall。
- 指纹：目标 os/cpu、上述 lock 内容及准备/验证实现。应用版本和无关依赖不参与 tsx/sharp 指纹；文档/语音原生资源指纹规则不变。
- 缓存：`src-tauri/resources/npm-runtime-cache/<name>/<os>-<cpu>/<fingerprint>/`。完整文件清单检查哈希、大小、可执行权限、相对符号链接及额外文件；校验 native 文件的目标架构。host target 另实际执行 tsx JSON loader、esbuild 和 sharp 图像转换。
- 发布：验证通过后将 cache payload **复制**到 `tsx-runtime` / `sharp-runtime`，不使用 hardlink。macOS 继续对打包副本做完整 Mach-O 验证和签名，不能修改 cache。
- 并发：复用 `withResourcePrepareLock` 串行化这两个资源的准备/投影。它不承诺整个 checkout 的并行构建安全；Tauri snapshot / 平台签名期间仍不能由另一次 build 改写同一 staging。
- 失败：先在临时目录安装和验证；失败不覆盖已发布资源。正常投影替换失败时回退原目录。进程强杀不是跨目录事务保证；再次执行准备入口从已验证缓存重新投影即可。

保留 tsx 的 exact pin 和 JSON require 回归检查；移除 watch-only 的 fsevents，拒绝意外原生库。sharp 的 native 包版本来自锁定的依赖关系，所有 release 平台均走同一准备入口，平台签名仍由平台脚本负责。

## 日志与成本

准备日志使用 `HIT`（校验后复用）、`MISS`（指纹变化/缺失/损坏，需要准备）、`STAGED`（复制到本次打包目录）与 `WAIT`（等待资源锁）。已有 Node 下载器保留带版本/架构原因的 `[nodejs]` 日志；文档、语音与 CLIProxy 同样标记缓存结果。Cuse 在判断本地资源前仍会联网检查当前发布清单，`CHECK` 不等于下载完整资源。

热缓存仍要读文件校验并复制，不能承诺零 IO 或整个 build 离线。前端与 Node 业务产物每次重建一次；Rust 保留自身增量编译机制。完整安装包、签名及真实 OS 运行仍按对应平台发布指南验收。

## 下载时限、重试与原始缓存

构建资源的 HTTP 字节获取共用 `build-resource-download.mjs`，版本选择、SHA/签名校验、缓存提交仍由原资源 owner 负责。Cuse、CLIProxy 每次请求（含响应体）至少 300 秒；默认三次尝试，仅临时网络故障和 408/429/500/502/503/504 退避重试。永久 HTTP、超限或校验失败不以重复请求掩盖。错误包括请求 URL、已尝试次数与单次时限。

文档/语音锁定大资源默认每次 30 分钟，显式更长时限仍保留；先走同一 Node transport，耗尽临时网络重试后保留原有 curl 代理兼容回退。curl 每次 transfer 有界，进程预算覆盖全部四次 transfer 与重试间隔。完整性失败不触发 curl 回退，只有校验成功的文件能进入内容寻址缓存。原有离线命中、旧 cache 迁移与 fingerprint 规则继续有效。

Cuse 的原始 ZIP 使用同一 `acquireLockedResource` helper，缓存到 `resources/cuse-cache`；解包到 `bundled-skills/cuse` 后的平台签名只改变构建副本。当前 release metadata 仍每次检查，不把旧缓存当成最新发布。CLIProxy 继续按仓库签名快照选择版本，其已有 ZIP 缓存不变。Node、tsx、sharp 已有的 target/version cache 和复制流程不另建一套。

尚无 Node 的引导阶段使用平台自带下载器：Unix Node curl 为 300 秒/次、最多三次尝试；Windows Node/rustup/Git 共用 PowerShell 5.1 兼容的 `download-build-file.ps1`，300 秒/次、最多三次临时故障重试，私有 partial 下载完成后才替换目标，失败清理 partial。Windows Git installer 不再仅判断文件存在，历史半包和新下载均须通过 Authenticode 完整性校验。npm、Cargo、Git 自身获取依赖仍由各包管理工具负责；发布上传与 App 运行时下载不属于此策略。

## 修改时的验证与文档维护

- **先确定影响面**：列出资源 owner、版本来源、host/target、缓存与 staging，以及调用该 helper 的 setup/dev/release 入口；修改公共 helper 时检查所有调用方。
- **选择对应验证**：`package.json` 的 `test:build-scripts` 是脚本测试入口；按影响面选择其中的下载、缓存、资源准备和构建接线用例。Linux 入口另有 `test:linux-package`。不能只验证一个入口而遗漏同一 helper 的其他平台。
- **验证真实边界**：涉及签名改变字节、跨目标原生产物或平台文件替换时，补最小相关真实验证；测试替身通过不等于 Windows/macOS/Linux 真机通过。无法执行的检查明确报告，不能记为 PASS。
- **保持规范与实现一起变化**：通用原则与 helper 分工在本文维护，资源专属契约在所属技术文档维护，操作步骤在平台指南维护。改变默认参数时核对本文的现状描述；不把同一规则复制到多个文档或核心指令中。
