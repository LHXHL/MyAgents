# Agent 网络

客户端实现位于 `src-tauri/src/agent_network/`、`src/server/agent-network/` 和 `src/renderer/features/agent-network/`。云端代码属于独立的私有仓库 `hAcKlyc/MyAgents_AgentNet`；账号扩展属于 `MyAgents_space`。本文件说明当前代码边界，不代表云端已部署或跨设备验收已完成。

## Owner 与状态

| 事实                                                     | 权威入口                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| 当前登录、sessionBindingId、设备身份代次                 | 原 Rust Space connector 与 Space 账号服务                              |
| 稳定设备 ID、OS/设备名称                                 | 原 `device_identity`                                                   |
| 工作区与 Agent 的本地身份、路径、生命周期                | `resolvePersistedAgentWorkspaceRegistry`；不得用网络设置反向创建工作区 |
| 私钥、设备 WSS、内层 TLS、连接 epoch、传输分配           | App 级 `AgentNetwork`，不归 Tab 或 Session                             |
| 网络 membership、Agent enabled/description、CAS revision | 同网络 SQLite Durable Object                                           |
| Session 出生、接纳、queue、历史和 terminal               | 原 Inbox、SessionStore、SidecarManager 与 SessionEngine                |
| 页面与 @ 草稿                                            | Renderer 投影；不持有云凭据、私钥或可执行许可                          |

设备入网与设备在线是两个事实。入网默认全部 Agent 关闭；退出清空启用设置，重入仍全部关闭。离线设备可以管理设置；目录仅提供当前可调用对象。没有入网的来源可以主动调用已开放目标并接收当前连接内关联回程。

## 调用与回程

CLI 使用原 `agent list/show`、`session list/get/start/send/watch` 命令。`src/shared/agentNetworkRouting.ts` 只区分本地 ID 与 `ma-agent:1:service:network:mount` / `ma-session:1:service:network:mount:localSession`。本地沿原 owner 路径；远端经来源 Node → Rust Management → App connector → relay → 目标原 owner。不能把 arbitrary Admin path、配置覆盖或远端文件路径送入 transport。

目标先由原 owner 冷准备，在网络等待期间释放 Session 生命周期锁；拿到当前授权 permit 后，在本机检查账号/连接/代次/有效期，再交给原 Inbox。最后交接以后是 in-flight，不能承诺 Rust 与 Node 跨进程原子撤销。`start/send` 返回真实接纳结果，不等待 AI terminal；明确失败、已接纳与 unconfirmed 必须区分，不自动重发。

来源/目标 return registry 只持有当前连接的关联。terminal 回调来自实际 Session Sidecar generation；目标重新获得当前授权的 route rebind ACK 后才发送私密 event。来源验证完整 peer/epoch/Session/message/watch 后投递原 Inbox，记录紧凑 settlement 再 ACK。ACK 不明不重复注入，不保存 outbox。真实断线、登出或身份改变丢弃关联；目标原执行继续。watch 仍是原一次完成通知登记；删除时只删除该 Session/watch/reference，不能清空其它 watch。

## 身份、加密与资源

外层是平台 HTTPS/WSS + 稳定设备公钥绑定 DPoP。接入凭据不超过原 Space 登录剩余有效期与 30 天；设备 leaf 有效 7 天，在 48 小时窗口按需续签。活跃回程使用一项带 jitter 的约 6 小时检查，空闲不轮询凭据或证书。暂时签发不可用且现有 leaf 尚有效时保留当前关联，真实撤销与过期不能忽略。

内层为标准 TLS 1.3 双向证书认证，验证双方当前 Space signed binding、SAN 与 fingerprint。完整 invocation、response、event/history 在内层加密；设备目录、设置和有界路由元数据不要求 E2EE。Worker 只转发 opaque TLS chunks，不组装或保存业务正文、密文和离线消息。密钥只使用系统凭据库，没有明文降级。

闭合 schema、限定 selector 和预算由中立协议包定义；当前源码位置、跨仓库分发与已约定的后续调整见下文“公共协议与仓库分发”。

`memory.rs::MemoryBudget` 是 App 级非阻塞字节分配，覆盖准备/排队的请求与回调、并行 owner 读取、未消费 Work 结果、TLS 编码、组装和解码。分配随实际字节增长，RAII 随取消、失败和 owner 交接释放；不能给每个小读取预占最大历史页。流控 credit 与业务接纳是不同事实。紧凑去重不保留读取正文，容量拒绝属于当前请求，不应断开其它 Agent 的正常连接。协议逻辑预算不能代替真实进程 RSS/平台缓冲容量测试。

## 目录、@ 与 query 生命周期

`discoverAgents/getAgentDiscovery` 复用本地身份 owner，合并 Rust 当前网络目录。CLI 保留原本地完整 registry；紧凑 @ projection 有明确预算/完整性状态。只有同设备、同 localAgentId 的网络 alias 才能与本地项折叠。目录与引用不授予执行许可。

@ 空关键词只查询/展示 Agent、想法，有关键词后按 Agent→想法→文件拼接，一个滚动/键盘导航区域；每组默认五项，展开更多每次最多增加五项，visibleCount 与 owner 页缓存分离。面板固定目标高度，加载/搜索/展开不随结果条数缩放，shared Popover size 只按 anchor 可用空间约束；composer 保留顶部栏空间。本机图标沿 ConfigData 的现有工作区身份投影，远端统一图标；想法日期/标签/摘要只占一行。想法沿原 ManagedRecordStore text Record projection；文件沿原 WorkspaceFileService/Rust walk。stateless cursor 绑定 scope/query/snapshot；hasMore 与 scanLimitReached 区分，超预算或目录不可用不得假报全部/空。

正文保留完整 `@Agent-id:selector`。快照只含 discovery 数据与账号 generation，提交时由 SessionEngine facade 重新查同一业务目录。未知/旧账号引用保留普通正文并给重新选择提示；不猜同名对象。`composeQueryReminder` 把 AgentInfo 与固定 instruction 放入一个 leading envelope，保留 Goal/任务讨论/悬浮球 primary context；名称/description 只能作为 escaped untrusted data。

原 SessionMessage 的 `desktopQuery` 保存可见正文与结构化上下文，builtin/external codec、queue、retry 共用它。重试重新查目录，不从任意用户 XML 反推可信上下文。Launcher、失败恢复、取消排队和跨 Runtime fork 保存相同快照；发送等待期间已开始的下一份草稿不能被清空。展示/搜索/队列预览继续使用原 reminder visibility helpers。

## 公共协议与仓库分发

协议包 `@myagents/agent-network-protocol` 是 TypeScript 契约、引用编码、传输封装和资源预算的共同定义，生成的 JSON Schema 与 fixtures 供 Rust 校验使用。协议版本独立于客户端和服务端产品版本；它不包含 Cloudflare Worker、账号签发或 Agent 执行实现。

### 源码与消费入口

- 唯一可编辑源码 authority 是 `MyAgents_AgentNet/packages/agent-network-protocol/`。客户端没有该源码目录；协议更改必须回到 AgentNet，再更新固定产物，不能手工修改包内 Schema。
- 客户端提交 `vendor/agent-network-protocol/manifest.json` 和带摘要前缀的 `.tgz`；根依赖及锁文件固定引用此文件。清单记录包版本、SHA-256、源码 authority、许可及来源服务端提交。客户端产品版本不等于协议包版本。
- `scripts/verify-agent-network-protocol.mjs` 在安装后、类型检查、Web/Node bundle 构建前检查摘要和依赖/锁文件指向。损坏或错配直接失败，修复所提交的产物或引用，不从服务端下载源码回退。
- Rust 的 `src-tauri/agent-network-protocol/` 是本机类型/codec 适配层；其 `build.rs` 独立校验同一压缩包，将其中平面 JSON Schema 与 fixtures 写到 `OUT_DIR`，不需要 Node、私有仓库权限或已安装 npm 包。产物改变时 Cargo 重新生成，并清理旧投影避免缺失文件被旧缓存掩盖。Rust 类型与 TS 契约通过包内 fixtures 校验，不另写 JSON Schema。
- AgentNet 自身也使用固定产物，并在 `protocol:source` 中生成临时 npm pack 核对源码与所提交的包完全一致。固定产物是单一源码的分发结果，不是另一份可独立维护的契约。

### 更新流程

1. 在 AgentNet 修改源码、生成 Schema、完成类型/fixture 检查，打包并更新该仓库的产物、来源清单和依赖/锁文件；完成检查、审查并提交。
2. 从已提交的 AgentNet 来源导入同一包到客户端 `vendor/agent-network-protocol/`，记录对应服务端源码提交，更新根依赖与锁文件；不修改包内定义或提交构建投影目录。
3. 运行客户端产物校验、TS/Rust parity、受影响业务测试和构建，并运行服务端 source/artifact 校验。根据真实协议兼容责任决定部署顺序，不随客户端版本机械升级、不自动重发不确定调用。

具体打包和导入命令由 AgentNet 的 `specs/PROTOCOL.md` 维护；普通构建不执行跨仓库打包或拉取源码。包随公开客户端提交，使新的贡献者无需私有 AgentNet 权限即可构建。源码迁移不代表自部署认证、多网络 UI 或完整产品验收已经完成。

## Dev 环境

客户端沿现有开发者设置选择 Space dev；`build.rs` 注入对应公开 AgentNet service ID，release 不携带可切换的 dev origin。服务端先部署 Space dev additive API/issuer/named `AgentNetworkEntrypoint`，再部署 AgentNet dev，最后验证客户端 dev 构建。记录 exact Git SHA、Worker Version ID 与 100% traffic；产品完成仍需 PRD/RFC 的完整矩阵。

设备详情的 `lastNetworkSeenAt` 来自网络 DO 的 ready/连接关闭与 Hibernation auto-response 在线事实，不能用账号 roster 的 `lastAccountSeenAt` 代替。Project 的 `agentNetworkExposureRevision` 由原归档配置入口持久化，UI/CLI 共用 `nextAgentNetworkExposureRevision`；unarchive 保留该代次。catalog `exposureRevision` 比旧代次增加时原 DO 事务关闭 mount，解决离线 archive→unarchive 被最终 snapshot 合并的问题；rename 不增加代次，简介仍由网络设置 owner 保留。

同 pair 连续完整对象在原 rustls writer 中有序写入，受 `receiveBytes` 和 App `MemoryBudget` 限制；信用窗口只控制 TLS 帧发出，不能把正常第二对象视为连接故障。终止性 pair 写入/加密错误只关闭该 pair，清理它的 pending 调用，保留其他 pair/有效逻辑回程；没有另建执行队列或断线重发。

### Metadata failure outcomes

Metadata reads and connection snapshots do not assert a user save. After metadata queue handoff, timeout or a dropped connection future yields uncertain outcome only for membership/enable/description writes; receipt inspection remains read-only and no write is replayed. Actual auth-generation changes fence discarded account scope; transport or power-generation changes alone are not evidence of account change. The existing actor reconnect loop owns recovery; Renderer describes that state and keeps its read retry separate from write receipt recovery.
