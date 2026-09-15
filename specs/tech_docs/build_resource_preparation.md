# 构建资源准备与复用

## 职责

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
