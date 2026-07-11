---
type: prd
status: implemented
created: 2026-07-11
updated: 2026-07-11
scope: "Team Space 一期体验与商业地基收口：Issues 新增服务端「与我相关」组合筛选并统一 updatedAt 语义；集合页扩宽到 6xl；Registered Agent 改为设备级客户端在线/离线表达；建立账号级、有有效期的 Pro 会员与 Free/Pro 配额解析、到期软降级；在 myagents.io/admin 新增「运营」Tab，集中完成账号 Pro 授予、延期、撤销、套餐权益查看与操作审计；桌面端账户菜单和 Space Overview 展示真实权益。"
issue: "产品需求讨论：Team Space 高阶商业体验优化、账号 Pro 会员、设备 presence 与 Space 运营后台（2026-07-10—2026-07-11）"
research: "specs/ARCHITECTURE.md; specs/DESIGN.md; specs/tech_docs/space_cloud.md; specs/prd/prd_0.2.49_space_settings_members_and_plans.md; specs/prd/prd_0.2.50_space_beta_capacity_hardening.md; src/renderer/api/spaceCloud.ts; src/renderer/pages/space/; src-tauri/src/space_cloud.rs; /Users/zhihu/Documents/project/MyAgents_space/src/; /Users/zhihu/Documents/project/MyAgents_space/migrations/; /Users/zhihu/Documents/project/MyAgents_web/src/pages/admin/; /Users/zhihu/Documents/project/MyAgents_web/worker/"
review: "implemented；Space Cloud、Website Admin、Desktop 分别完成独立架构/对抗/UX review，最终复审无 Critical / High / Medium。三仓自动化验证均通过；由于本轮无可用浏览器视觉后端，Desktop 800×600 / 常规宽屏与 Website 1024px 的真实运行截图验收仍须在合并发布前人工完成。"
---

# Team Space 一期体验收口、Pro 会员与运营后台 PRD

> 产品版本：`0.2.50`
>
> 本文是独立开发契约；实现时不得依赖本轮聊天记录。

## 执行须知（给空 session 的你）

本需求横跨三个同级仓库，但每一类事实只有一个 owner：

| 仓库 | 责任 |
|---|---|
| `/Users/zhihu/Documents/project/MyAgents` | 桌面端 Renderer、Rust/Tauri Space Cloud 边界、本地 Registered Agent connector、账户菜单与 Team Space UI |
| `/Users/zhihu/Documents/project/MyAgents_space` | Space Cloud Worker、D1/R2、账号会员、有效权益解析、quota、Issue 关系筛选、设备 presence、运营 API 与审计 |
| `/Users/zhihu/Documents/project/MyAgents_web` | `myagents.io/admin` 的管理员认证、运营 UI、到 Space Cloud 的受保护 server-to-server proxy |

动手前必须主动读：

- MyAgents 主仓当前会话加载的 `AGENTS.md` / `CLAUDE.md`。
- `specs/ARCHITECTURE.md`：确认 Team Space 不是 Sidecar/AI Runtime；Renderer 的 Space HTTP 仍经 Rust/Tauri。
- `specs/tech_docs/space_cloud.md`：确认 Space session、registered-agent token、delivery poll、mock mode、quota 与事件同步的既有边界。
- `specs/DESIGN.md`：本期会改集合页、筛选栏、状态 badge、账户菜单、提示条和窄窗布局。
- 三个仓库自己的最新源码与仓库指令。本文给出的是 2026-07-11 的已核实 ground truth；若符号移动，按语义寻找，不使用行号。

关键入口：

- Desktop Renderer：
  - `src/renderer/api/spaceCloud.ts`
  - `src/renderer/pages/space/SpaceChrome.tsx`
  - `src/renderer/pages/space/spaceUi.ts`
  - `src/renderer/pages/space/spaceHelpers.ts`
  - `src/renderer/pages/space/spaceStore.ts`
  - `src/renderer/pages/space/issues/IssuesWorkspace.tsx`
  - `src/renderer/pages/space/skills/SkillsWorkspace.tsx`
  - `src/renderer/pages/space/agents/AgentsWorkspace.tsx`
  - `src/renderer/pages/space/settings/SpaceSettingsWorkspace.tsx`
- Desktop Rust：
  - `src-tauri/src/space_cloud.rs`
  - `src-tauri/src/space_cloud_mock.rs`
  - `src-tauri/src/lib.rs`
- Space Cloud：
  - `/Users/zhihu/Documents/project/MyAgents_space/src/index.ts`
  - `src/constants.ts`
  - `src/domain/types.ts`
  - `src/services/adminAuth.ts`
  - `src/routes/admin.ts`
  - `src/services/pollPolicy.ts`
  - `migrations/`
  - `test/space-routes.test.ts`
- Website Admin：
  - `/Users/zhihu/Documents/project/MyAgents_web/src/pages/admin/Dashboard.tsx`
  - `src/pages/admin/useAdminApi.ts`
  - `src/pages/admin/SpaceDashboard.tsx`
  - `worker/index.ts`
  - `worker/routes/spaceDashboard.ts`
  - `worker/middleware/auth.ts`
  - `worker/types.ts`

实现原则：

1. Space Cloud 是账号会员、quota、Issue 关系和 presence 的唯一业务权威；Desktop 与 Website 不复制判定规则。
2. Website Admin 不直连 D1，也不把 Space operations secret 发给浏览器。
3. Registered Agent delivery GET 继续保持纯读；presence 使用独立、合并后的设备级 touch。
4. Pro 到期不靠 cron 改状态，不批量改 Space，也不删除任何存量；所有请求按当前时间解析有效权益。
5. 本 PRD 对“账号会员决定 billing owner 权益”的定义，覆盖 `prd_0.2.49_space_settings_members_and_plans.md` 中把 paid plan 仅视为静态 Space 字段的旧假设；Space 仍然是 quota 计算单元。
6. 三仓应各自建立功能分支并分仓提交。`MyAgents_web` 的生产分支可能自动部署，未经用户验收不得直接合入发布分支。

---

## 1. 背景与产品判断

Team Space 已经具备 Issues、Goals、Skills、成员、Registered Agents、Claims、评论、附件和 Space Settings 等真实能力，但当前一期界面仍暴露出四类核心错位：

1. **高频工作到达效率不足。** Issues 能按状态、目标和搜索筛选，却不能快速找到“我或我的 Agent 真正参与过的事情”。
2. **列表与时间语义互相矛盾。** 云端已经按 `updatedAt` 倒序返回 Issue / Skill，界面却展示 `createdAt`，用户无法解释列表为什么这样排序。
3. **Agent 状态不可信。** 当前卡片把配置态 `active` 和在线态混成同一个绿色信号，并在没有设备活跃时间时拿 `updatedAt` 冒充“上次同步”。
4. **商业能力只有 quota 外壳，没有账号身份与运营闭环。** 现有 Free 配额已存在，但没有 Pro 权益表、有效期、到期语义、运营授权入口和桌面端身份反馈。

本期产品判断：

- Team Space 的长期主叙事是“组织团队注意力，并让 Agent 执行”，不是四类资源的并列管理器。
- Space Dashboard 确实是信息架构缺口，但本期明确不做。不能放一个空入口，也不为它提前制造新业务对象。
- 一期先把最频繁、最容易伤害信任的语义做准：我相关的工作、最近更新、真实在线、真实会员与真实 quota。
- 美感不靠装饰、金色渐变或更多卡片获得，而来自清楚的层级、准确的状态、合理的内容宽度、稳定的反馈和克制的品牌细节。
- Pro 一期只扩大容量，不阉割协作功能。Free 用户能够体验完整闭环；Pro 的付费价值是更多 Space 与更大的团队/自动化规模。

### 1.1 用户核心意志

> “交互易用性做到足够好，同时页面足够精美，是易用、好看、愿意付费的高阶商业产品的水平。”

> “与我相关只是去我评论过、我创建的、我经手的（claim）以及我账号下的 Agent 做了这些事的。”

> “我作为接手 issue 的人，产生了这个关系……我是经办人，我是执行者，这个关联关系和状态应该没关系。”

> “作为维护 Agent 运行 harness 环境的 MyAgents 客户端，才是那个心跳的人。”

> “到期后各种 quota 恢复到免费账号的水平……超出的内容不会删除，仍然保留可见。”

> “这是一个 MyAgents Space 的运营能力。把它合并在 myagents.io/admin 里面，顶部 tab 加一个『运营』tab。”

### 1.2 本期必赢场景

1. 成员进入 Issues，组合使用“未完成 + 某目标 + 与我相关 + 搜索”时，得到完整、可分页、可解释的结果。
2. 列表第一眼告诉用户“最近发生了什么”，日期能解释排序；后台更新不会在用户阅读时让行突然跳动。
3. 管理员进入 Agents，一眼区分工作区是在线、离线还是已停用，并通过“添加本机 Agent 工作区”完成接入。
4. 运营人员在 `myagents.io/admin` 搜索一个账号，能在一分钟内安全授予、延期或撤销 Pro，并看到精确有效期、受影响 Space 与审计记录。
5. Pro 账号立即覆盖其作为 billing owner 的全部 Space；到期后恢复 Free quota，存量资源完整可读、可运行、可删减，没有破坏性降级。

---

## 2. 范围

### 2.1 本期包含

#### Desktop Team Space

- Issues 顶部新增独立 toggle：“与我相关”。
- “与我相关”与状态、目标、搜索、`humanOnly` 等现有条件做 AND 组合。
- Issue 与 Skill 列表按 `updatedAt DESC` 排序并展示最近更新时间。
- 本人 mutation 后立即重排；后台 event 到来时显示“有更新，点击刷新”，由用户触发统一重排。
- Issues、Skills、Agents、Members 集合页主内容宽度从 `max-w-4xl` 提升为 `max-w-6xl`。
- 窄窗筛选栏稳定换行。
- Agent 卡片主状态改为“在线 / 离线”；`active / disabled / revoked` 保留为管理状态。
- “登记 Agent”系列文案统一改为“添加本机 Agent 工作区”。
- 左下角账户菜单展示 Free/Pro 账号身份与 Pro 有效期。
- Space Overview 展示当前有效套餐、有效期、usage/limit 与到期后超额状态。

#### Space Cloud

- 新增 `free / pro` 两档类型化权益配置。
- 新增账号级 Pro 会员记录、绝对有效期、撤销、来源、操作者、原因和版本。
- 新增不可篡改的运营事件审计。
- 按当前时间解析账号有效套餐，并投影到该账号承担 `billingOwnerUserId` 的 Space。
- Space 创建改为动态、原子的 owned Space quota；移除依赖静态 Free 字段的唯一索引。
- 所有 quota 统一执行“只拦正向 usage delta”的软降级语义。
- 新增服务端 `related=me` Issue 关系筛选及对应索引。
- 新增设备级 connector presence 字段与独立 touch API；Agent 列表返回服务端计算的在线状态。
- Session / Space Overview 返回账户权益与 Space 有效套餐投影。

#### myagents.io/admin

- 顶部新增第三个主 Tab：“运营”。
- 运营页包含三个二级区：
  - 账号权益
  - 套餐权益
  - 操作记录
- 支持按精确邮箱或 User ID 查找账号。
- 支持立即授予/重新开通 Pro、延长 Pro、立即撤销 Pro。
- 支持 1/3/6/12 个自然月和自定义到期时间。
- 提交前预览精确时间范围、受影响 Space 和动作结果，并二次确认。
- 展示账号当前权益、owned Spaces、各 Space usage/limit/超额状态与账号操作历史。
- 套餐权益一期只读，直接展示 Space Cloud 返回的 Free/Pro 权益矩阵，不在 Website 复制数值。
- 全局审计支持按账号、动作、操作者和时间过滤。

### 2.2 明确不做

- Space Dashboard、Dashboard 空入口、Dashboard 专用后端聚合对象。
- Issue 关注 / Watch / Follow。
- 批量 Issue 操作、保存筛选器、自定义视图。
- 公开购买、支付、订阅、自动续费、账单、发票、优惠码、退款。
- 桌面端“升级 Pro”按钮或不可用的购买 CTA。
- 动态在线编辑套餐数值；本期套餐权益由 Space Cloud 代码配置并在运营页只读展示。
- 自定义套餐、自定义 quota、按单个 Space 单独覆盖账号套餐。
- 宽限期、欠费重试、支付订阅状态机。
- 管理员细分角色。Phase 1 继续复用 `ADMIN_EMAILS` 白名单，但所有写操作必须审计。
- 逐 Agent heartbeat、新的高频 scheduler、WebSocket presence。
- 因 Pro 到期删除、隐藏、归档或自动停用任何已有对象。
- 修改 Registered Agent delivery GET 的纯读语义。
- Goals 页面结构重做、Issue/Skill detail drawer 全面重做。

---

## 3. 当前技术事实与必须修正的错位

### 3.1 Desktop

- `spaceUi.ts::SPACE_LIST_FRAME_CLASS` 当前是 `mx-auto max-w-4xl`，同时被集合页和部分阅读/设置页复用；不能直接把这个常量全局改成 6xl。
- `IssuesWorkspace.tsx` 当前展示 `issue.createdAt`。
- `SkillsWorkspace.tsx` 当前展示 `skill.createdAt`，且只显示日期。
- Space Cloud 的 Issue 与 Skill 查询已经以 `updated_at DESC` 为主要排序，前端展示的创建时间不能解释顺序。
- `spaceListIssues`、`IssueQueryParams`、`buildIssueQueryKey`、`spaceStore` 的规范化与缓存 key 当前都没有 `related` 维度。
- `spaceStore` 已有 15 秒 Space event cursor 同步；本期继续复用，不增加第二套实时状态系统。
- `AgentsWorkspace.tsx::agentCardTimeLabel` 优先取设备 `lastSeenAt`，没有时回退 `agent.updatedAt`。配置更新时间不能再被标为同步/在线时间。
- Agent 后端真实管理状态是 `active | disabled | revoked`；当前样式 helper 把 `active` 或字符串 `online` 都映射为成功绿色，语义混淆。
- `SpaceChrome.tsx::SpaceSidebar` 左下账户弹层当前与 sidebar 同宽，身份区不足以承载套餐与有效期。
- Renderer 所有 Space API 仍必须经 `spaceCloud.ts` 和 Rust command；禁止 WebView 直连 Space Worker。

### 3.2 Space Cloud

- `SPACE_PLAN_LIMITS` 当前只有 `free`。
- `getSpacePlanLimits(space)` 当前无条件返回 Free。
- `spaces` 已有 `plan_tier` 和 `billing_owner_user_id`；前者不能继续作为动态账号会员的事实源，后者仍是把账号权益投影到 Space 的关键 owner。
- `idx_spaces_free_user_space_per_owner` 通过 `plan_tier='free'` 限制一个 owner 只能有一个 Space。动态会员到期后必须保留多个既有 Space，该索引与新语义不兼容。
- `user_devices.last_seen_at` 会被登录、进入 Space、登记/编辑设备等普通活动刷新，不能直接代表 connector 存活。
- `GET /api/registered-agents/me/deliveries` 被既有容量 PRD 和架构定义为纯读，不能顺手写 heartbeat。
- `issue_comments` 只有按 issue/time 的索引；“与我相关”还需要按 author 查 issue。
- `idx_issue_claims_actor(actor_type, actor_id, status)` 服务 active claim 查询；经办历史不按 status，需要独立关系索引。
- `registered_agents` 已能从 `owner_user_id` 找到账号拥有的 Agent，且绑定 `device_id`。
- 当前 `/api/admin/dashboard/*` 只有只读统计接口，由 `requireSpaceAdminApiKey` 保护。

### 3.3 Website Admin

- `Dashboard.tsx::AdminPage` 当前只有 `product | space`。
- 顶部主 Tab 当前是“总体统计 / MyAgents Space 统计”，通过 `?page=space` 维护状态。
- 日期范围选择器对统计页有意义，对运营配置没有意义。
- Website 用 Google OAuth、`admin_token` cookie、`requireAuth` 和 `ADMIN_EMAILS` 保护后台。
- 当前 Space admin proxy 从 Website Worker 使用 `SPACE_ADMIN_API_KEY` 调 Space Worker，并对只读 GET 做约 5 分钟 edge cache。
- Pro 授权是写操作且包含账号隐私数据，不能复用缓存路径，也不应让现有统计 secret 自动获得写权限。

---

## 4. 信息架构与视觉总则

### 4.1 Desktop Team Space

本期不改变一级侧栏的 `Issues / Goals / Skills / Settings` 结构，不新增 Dashboard。改动聚焦内容区和账户菜单：

| 页面类型 | 内容宽度 | 说明 |
|---|---:|---|
| Issues / Skills / Agents / Members 集合页 | `max-w-6xl`（约 1152px） | 提升宽屏信息密度，让双栏卡片与元信息有真实空间 |
| Overview / Roles / 设置表单 / 说明正文 | 保留较窄阅读宽度，原则上 `max-w-4xl` | 防止说明文字和表单跨得过宽 |
| Goal 主从分栏 | 保持既有独立布局 | 不套用集合页常量 |
| Detail drawer / modal | 保持任务所需 measure | 本期不因列表扩宽而同步拉宽 |

实现时拆分语义常量，例如：

- `SPACE_COLLECTION_FRAME_CLASS`：6xl
- `SPACE_READING_FRAME_CLASS`：4xl 或既有阅读 measure
- `SPACE_FORM_FRAME_CLASS`：表单所需宽度

命名可按代码风格调整，但禁止继续让一个共享常量无差别控制所有内容。

### 4.2 状态视觉

- 主色仍使用 paper / ink / monochrome primary。
- Online 使用现有成功色，但必须配文字“在线”，不能只靠绿色圆点。
- Offline 使用中性灰文字与 outline badge，不使用错误红。
- Disabled 不与 offline 混在一起：整卡降低对比度，并明确显示“已停用”。
- Pro 只使用克制的暖色 accent、细描边或浅底 badge；禁止皇冠、发光、金色渐变和“尊贵”文案。
- 危险操作“撤销 Pro”使用错误色，但默认不成为页面最大视觉焦点。
- 所有颜色必须来自 `specs/DESIGN.md` 的 CSS token，不硬编码。

### 4.3 动效与稳定性

- 列表 hover 只做背景/边框/轻微阴影变化；禁止整卡浮起、缩放。
- 远端更新不让当前列表行自动跳位。
- 状态 badge 可原位更新；排序只在明确刷新、重新进入或本人 mutation 后执行。
- skeleton 的尺寸应贴近真实内容，避免加载后整体跳动。
- overlay、确认框、账户菜单必须接入 `useCloseLayer`；遮罩使用 `OverlayBackdrop`。

### 4.4 800×600 是一级验收尺寸

- Issues 工具栏允许变成两行，搜索/筛选不会挤成不可点击。
- 创建与刷新动作保留稳定位置，不因“与我相关”出现而溢出。
- Skills/Agents 双栏在空间不足时降为单栏。
- 账户菜单始终完整落在 viewport 内，不被底部或左侧裁切。
- 运营后台以桌面浏览器为主，但 1024px 宽度仍必须可操作；表格可横向滚动，核心动作不能消失。

---

## 5. Issues：「与我相关」

### 5.1 产品定义

“与我相关”是一个独立的**行为关系筛选**，不是 claim 当前状态，也不是“只看我当前负责”。

对当前登录的人类用户 `U`，某 Issue 只要满足以下任一条件，就属于“与我相关”：

1. `U` 创建过该 Issue；
2. `U` 评论过该 Issue；
3. `U` 曾经 claim / 经手过该 Issue；
4. 由 `U` 拥有的任一 Registered Agent 创建过该 Issue；
5. 由 `U` 拥有的任一 Registered Agent 评论过该 Issue；
6. 由 `U` 拥有的任一 Registered Agent 曾经 claim / 经手过该 Issue。

六种关系内部是 OR；整个关系组与其他查询条件是 AND：

`state AND goal/subtree AND q AND humanOnly AND related=me`

### 5.2 历史关系规则

- claim 一旦发生，就建立“经办/执行”关系。
- 后续 claim 状态变为 `completed` 或 `cancelled`，关系仍然成立。
- Issue 自身从未完成进入完成/关闭，关系仍然成立；是否展示由状态筛选决定。
- Agent 后续被 disabled 或 revoked，不抹除其历史行为关系。
- 不新增冗余的 `issue_relations` 或 `issue_participants` 表；当前创建者、评论和 claim 表已经是事实源。
- 本期不在 Issue 行额外展示“为何与我相关”的 badge；筛选正确性优先，解释型 UI 后置。

### 5.3 API

在现有列表 API 增加：

`GET /api/spaces/:spaceId/issues?related=me`

规则：

- 仅接受缺省或 `me`；其他值返回结构化 400。
- 仅人类 session auth 可使用 `me`。Agent token 列表接口不得复用“当前账号”语义。
- 结果仍由服务端排序、cursor 分页；严禁前端过滤当前已加载的 30/50 条。
- cursor 必须与 `updated_at DESC, id DESC` 的稳定排序一致。
- 查询必须同时覆盖本人 ID 与本人拥有的 Registered Agent IDs。
- 账号拥有 Agent 的关系不受 Agent 当前状态限制。

查询使用 `EXISTS` / 集合子查询，避免主查询多表 JOIN 导致重复 Issue；具体 SQL 必须通过 `EXPLAIN QUERY PLAN` 和真实种子数据验证。

新增索引：

- `issue_comments(author_type, author_id, issue_id)`
- `issue_claims(actor_type, actor_id, issue_id)`

保留现有 `idx_issue_claims_actor(actor_type, actor_id, status)`，因为 active claim poll 与历史关系查询是两种不同 access pattern。

### 5.4 Renderer / Store

以下链路必须全部增加 `related?: 'me' | null`，不能只改 URL：

- `spaceListIssues` 参数与 query string
- `IssueQueryParams`
- `buildIssueQueryKey`
- `normalizeIssueQueryParams`
- list cache key
- event 后的 list matching / invalidation
- mock mode
- 单元测试 fixture

toggle 规则：

- label：“与我相关”
- 默认关闭。
- 在当前 App Tab session 内按 Space ID 记忆；切换 Space 后各自保留。
- App 重启后恢复关闭，不持久化到账号或磁盘。
- 开启后保持明显 selected state，并可再次点击关闭。
- 与状态/目标/搜索同时生效；切换任一条件回到第一页。
- loading 时保留当前列表，筛选控件显示请求中，避免空白闪烁。
- 错误时保留旧结果并就地提供“重试”，不能悄悄回退为未筛选列表。

### 5.5 工具栏布局

宽屏第一行：

`搜索｜状态｜目标｜与我相关　　　　　　　　　创建｜刷新`

窄窗：

- 第一行保留搜索和主要动作。
- 第二行放状态、目标、“与我相关”。
- 控件保持最小可点击宽度，不把中文 label 压成省略号。
- “与我相关”是 toggle button，不做第四个下拉菜单。

---

## 6. Issue / Skill 的最近更新语义

### 6.1 排序与展示

- Issue 列表：`updatedAt DESC, id DESC`。
- Skill 列表：`updatedAt DESC, id DESC`。
- 行/卡片展示 `updatedAt`，中文语义为“更新于”或直接显示本地化时间。
- 时间展示需包含日期和时分；同日可用“今天 HH:mm”，但 tooltip 或可访问文本提供完整绝对时间。
- Detail 中可同时保留“创建于 / 更新于”，不删除 `createdAt`。
- Agent 列表不套用本规则；Agent 的主时间是最后在线时间。

### 6.2 实时重排

| 更新来源 | 行为 |
|---|---|
| 当前用户在本客户端完成 mutation | 更新对象并立即按 `updatedAt` 重排；这是用户刚刚发起且可预期的变化 |
| 15 秒 event cursor 收到远端 Issue/Skill 更新 | 不立即移动列表行；在列表顶部显示“有更新，点击刷新” |
| 用户点击提示条 | 强制刷新当前查询、回到服务端顺序、清除提示 |
| 用户手动刷新、重新进入页面或切换筛选 | 直接使用最新服务端排序 |

提示条：

- 不需要累计精确数量；一句“有更新，点击刷新”即可。
- 不能遮挡首行内容，使用轻量 inline banner。
- 提示出现期间，当前详情可更新内容，但列表位置不变。
- 同一批远端事件只显示一个提示，不堆叠 toast。

---

## 7. Registered Agent：管理状态与在线状态分离

### 7.1 三条状态轴

| 轴 | owner | 值 | 用途 |
|---|---|---|---|
| 管理状态 | Space Cloud Registered Agent | `active / disabled / revoked` | 是否允许该工作区继续作为 Space Agent |
| 客户端 presence | MyAgents 客户端/设备 | `online / offline` + last online | 维护 Agent harness 的客户端是否仍在轮询 |
| 执行状态 | Issue claim / delivery / local task | idle / claimed / running 等既有信息 | 当前是否正在处理任务；本期不新增全局执行 badge |

关键语义：

- Agent 工作区不是独立心跳 owner。
- MyAgents 客户端/设备活着并完成 connector poll，才代表其维护的 enabled Agent 工作区可在线。
- 同一设备上的多个 enabled Agent 继承同一个设备 presence。
- disabled 优先于 presence：即使设备在线，卡片仍显示“已停用”，不显示在线。
- revoked 默认不出现在列表。

### 7.2 为什么不能复用 `user_devices.last_seen_at`

当前 `last_seen_at` 还会被登录、进入 Space、登记/编辑等普通账号活动更新。用户打开页面不等于 connector 正常运行；若直接用它，会把不能接任务的 Agent 错报为在线。

在 `user_devices` 增加独立字段：

- `connector_last_seen_at TEXT NULL`
- `connector_online_until TEXT NULL`

保留 `last_seen_at` 原有含义，不改已有设备/账号活跃统计。

### 7.3 Presence touch

新增 token-only API：

`POST /api/registered-agents/me/device-presence`

行为：

- 使用现有 Registered Agent bearer token 鉴权。
- 服务端只从 token 对应记录派生 `owner_user_id` 和 `device_id`；body 不接受用户 ID、设备 ID 或 Agent ID。
- token 必须属于可运行的 active Agent；revoked/invalid token 拒绝。
- 更新对应 `user_devices.connector_last_seen_at` 与 `connector_online_until`。
- `connector_online_until` 从 Space Cloud 的有效 poll policy 最大间隔加容错派生，固定规则为 `max(configuredMaxInterval, configuredShedInterval) + 90s`；未配置 shed 时只使用 configured max。Renderer 不复制这个数字。
- 响应返回 `observedAt` 与 `onlineUntil`。
- 不写 `space_events`，避免 heartbeat 形成事件洪水。
- delivery GET 继续保持纯读。

### 7.4 Desktop connector 合并规则

在现有 connector owner 内完成，不增加新 loop：

1. 按 `(baseUrl, ownerUserId, deviceId)` 对本地 active Agent 分组。
2. 某组本轮至少有一次 delivery poll 成功后，从组内选择一个稳定的 active token 做一次 presence touch。
3. 同一设备 touch 至多每 60 秒一次；空闲轮询 300 秒时则随成功 poll 自然刷新。
4. 一个设备有 20 个 Agent，也只写一次设备 presence。
5. 如果选中的 token 刚好失效，本轮不循环轰炸；下一轮改用其他可用 token。
6. App 正常退出可 best-effort 结束 presence，但不能依赖退出通知；最终离线以 lease 到期为准。

本地节流状态属于 connector 进程内临时状态，不需要持久化。

### 7.5 服务端 Agent projection

Registered Agent 列表/详情返回服务端计算后的：

- `presence: 'online' | 'offline'`
- `lastOnlineAt: string | null`
- `onlineUntil: string | null`（供 UI/诊断使用，但 UI 不自己重算）

计算规则：

- `status !== 'active'` 时 UI 使用管理状态，不宣称在线。
- `status === 'active'` 且当前时间早于设备 `connector_online_until`：online。
- 其他：offline。
- 没有设备绑定或旧数据没有 connector presence：offline，而不是 unknown/active。

Agents 页面可见时每 60 秒 silent revalidate 一次列表，以便 lease 到期后 badge 更新；页面不可见时不轮询。Presence 只原位更新 badge，不实时重排。

### 7.6 卡片与排序

卡片主状态：

- active + online：绿色 outline/浅底 badge“在线”。
- active + offline：中性 outline badge“离线”；次要文案“最后在线：……”或“尚未在线”。
- disabled：整卡弱化，明确 badge“已停用”；不显示绿色在线信号。
- 新增或重新启用后，本地短暂显示“连接中”；首个 presence 到达后转在线，lease 内未到达则转离线并提供排查提示。

排序只在首载、手动刷新、重新进入时计算：

1. active + online
2. active + offline
3. disabled

同组按 `lastOnlineAt DESC`，无时间的排后。页面停留期间只更新状态，不自动换位。

文案统一：

- 主按钮：“添加本机 Agent 工作区”
- 空态 CTA：“添加本机 Agent 工作区”
- dialog 标题：“添加本机 Agent 工作区”
- 成功反馈：“已添加 Agent 工作区”
- 技术说明和详情字段可继续使用 Registered Agent。

---

## 8. Free / Pro 权益模型

### 8.1 权益矩阵

Free 与 Pro 功能相同，仅容量不同：

| 权益 | Free | Pro | 计算作用域 |
|---|---:|---:|---|
| 可拥有 Space | 1 | 5 | 账号；只数该账号是 `billingOwnerUserId` 的 user Space |
| 成员 | 3 | 20 | 每个 Space；不含 owner |
| 未完成 Issues | 100 | 1,000 | 每个 Space；`open / todo / doing` |
| Hosted Skills | 50 | 300 | 每个 Space；非 deleted Skill |
| Registered Agents | 6 | 40 | 每个 Space；非 revoked，disabled 仍计数 |
| Storage | 1 GiB | 20 GiB | 每个 Space；内部延续 1024 进制，产品显示 1 GB / 20 GB |

单个 Pro 账号的理论上限：

- 5 个 owned Spaces
- 100 个 owner 之外的成员席位
- 5,000 条未完成 Issues
- 1,500 个 Hosted Skills
- 200 个 Registered Agents
- 100 GiB Storage

这也是 presence 必须设备级合并，而不能逐 Agent 写入的容量依据。

### 8.2 权益定义的 owner

Space Cloud 中保留一份类型化配置：

`SPACE_PLAN_LIMITS: Record<SpacePlanTier, SpacePlanLimits>`

包含 `free` 与 `pro`。Website 与 Desktop 都只能消费 API 返回值，不能复制 quota 常量。

Phase 1 不把套餐配置做成 D1 可编辑表：

- 全局 quota 修改影响所有账号，必须随代码评审、测试和发布版本变更。
- 运营页“套餐权益”只读展示这份权威配置。
- 未来有定价版本、旧订阅保留权益、灰度套餐时，再单独设计 versioned plan catalog；本期不提前制造这套复杂度。

### 8.3 账号会员，Space 配额

- Pro 是**账号级会员**。
- 账号有效 Pro 自动作用于该账号作为 `billingOwnerUserId` 的所有 user Space。
- 账号加入他人拥有的 Space，不改变该 Space 套餐。
- Space 仍是成员、Issue、Skill、Agent、Storage 的 usage/quota 单元。
- official Space 继续使用 `space_kind='official'` 的既有配额豁免，不依赖某个运营账号的 Pro。
- `spaces.plan_tier` 不再是 quota 权威。为兼容旧数据可以暂留字段，但所有新判断与 API projection 必须走账号权益 resolver。

### 8.4 有效期

有效 Pro 的定义：

`startsAt <= now < expiresAt AND revokedAt IS NULL`

- 有效区间左闭右开。
- 时间统一以 UTC ISO timestamp 存储。
- UI 以用户/管理员本地时区展示，并在确认框给出完整日期时间及时区。
- 1/3/6/12 月按**自然月**计算，不按 30/90/180/365 天换算。
- 自然月运算由 Space Cloud 以 UTC 年/月/日/时分秒完成，避免 Website、Worker 部署区和管理员本地时区各算一套。
- 月末溢出取目标月最后一个合法日期。例如 1 月 31 日加 1 个月到 2 月最后一天。
- Phase 1 的人工授予/重新开通立即生效；不提供未来预约生效 UI。
- 有效 Pro 延长时，从当前 `expiresAt` 起加时长。
- 已到期、已撤销或从未开通过的账号，从服务器当前时间重新开始。
- 自定义到期时间必须晚于当前有效期基准。

### 8.5 数据模型

使用“当前会员投影 + append-only 审计”两层，而不是允许同一用户堆叠多个互相重叠的 grant：

#### `account_plan_memberships`

| 字段 | 说明 |
|---|---|
| `user_id` PK/FK | 一个账号最多一条当前 Pro 会员记录 |
| `plan_tier` | Phase 1 固定 `pro` |
| `starts_at` | 本次会员区间开始 |
| `expires_at` | 当前到期时间 |
| `revoked_at` nullable | 被人工撤销的时间 |
| `source` | `admin | promotion | future_payment`；Phase 1 写 `admin` |
| `reason` | 当前一次操作的运营原因摘要 |
| `granted_by` | 最近执行操作的管理员 email |
| `created_at` / `updated_at` | 审计时间 |
| `version` | 乐观并发版本，每次变更 +1 |

“没有记录”即 Free fallback，不为每个用户写 Free 行。

#### `account_plan_events`

| 字段 | 说明 |
|---|---|
| `id` | event id |
| `user_id` | 被操作账号 |
| `action` | `grant | regrant | extend | revoke` |
| `operator_email` | 来自可信 Website Worker，不接收浏览器自报 |
| `reason` | 必填 |
| `before_json` / `after_json` | 操作前后 membership projection |
| `idempotency_key` | 全局唯一，防重复提交 |
| `request_id` | 跨服务排障 |
| `created_at` | 操作时间 |

会员更新与 event 插入必须在同一 D1 transaction/batch 中完成；任一失败都不能出现“权益变了但无审计”。

### 8.6 单一 resolver

Space Cloud 在 `src/services/planEntitlements.ts` 集中新增领域函数：

- `resolveAccountPlan(userId, at)`
- `resolveSpacePlan(space, at)`
- `getPlanLimits(tier)`

返回形态至少包含：

`accountPlan`：

- `effectiveTier: 'free' | 'pro'`
- `evaluatedAt`
- `membership: null | { planTier, status, startsAt, expiresAt, revokedAt, source, version }`

`spacePlan`：

- `effectiveTier`
- `limits`
- `billingOwnerUserId`
- `expiresAt`（当前为 Pro 时）

状态 `active / expired / revoked` 是根据字段和 `at` 派生，禁止持久化一个需要 cron 翻转的 `is_active`。

同一次请求内应复用 resolver 结果，Space 列表按 distinct billing owner 批量取 membership，不能产生每个 Space 一次的 N+1 查询。

---

## 9. Pro 到期与 quota 增量门控

### 9.1 总原则

Pro 到期的瞬间，有效套餐自然解析为 Free：

- 不删除数据。
- 不隐藏数据。
- 不把 Space 设为不可访问。
- 不自动停用 Agent。
- 不自动移除成员。
- 不把 Issue 自动关闭。
- 不回滚 Skill revision。

只拦截会让对应 usage **正向增长**的 mutation。零增长与负增长动作始终允许，让用户可以继续协作并自行回到 Free 范围。

### 9.2 逐资源规则

| 资源 | 超额后禁止 | 仍允许 |
|---|---|---|
| Owned Spaces | 创建新的 user Space | 访问、编辑、离开、删除既有 Space |
| Members | 邀请、批准申请、添加 email 等会增加成员数的动作 | 改角色、移除成员、拒绝申请、撤销邀请 |
| Open Issues | 创建会计入 open quota 的 Issue；把 done/closed 重新打开 | 评论、编辑、claim、完成、关闭、删除；在终态之间切换 |
| Hosted Skills | 创建新 Skill | 读、下载、删除；已有 Skill 发新 revision 仅受 Storage 正增量约束 |
| Registered Agents | 添加 Agent；把 revoked Agent 恢复为 non-revoked | 既有 Agent 继续运行、编辑、disabled/active 切换、revoke |
| Storage | 上传任何会让占用字节增加的内容 | 下载、读取、删除；等量覆盖只有净增量部分受限 |

补充：

- disabled Agent 本来就计入 non-revoked quota，所以 disabled -> active 是零增量，允许。
- revoked -> active 会增加计数，超额时禁止。
- 关闭 Issue 是释放 quota，必须允许。
- 评论不增加 open Issue 数，即使当前已超额也允许。
- Skill 新 revision 不增加 Skill 数，但会增加 storage；只检查净新增字节。
- official Space 保持既有豁免。

### 9.3 Space 创建的原子性

必须删除/替换 `idx_spaces_free_user_space_per_owner`，因为账号从 Pro 到期后允许保留 2–5 个既有 Space。

创建 user Space 时：

1. 在服务端解析当前账号 effective plan。
2. 获取 `ownedSpacesMax`。
3. 在同一原子写入路径里做 conditional insert；并发两个创建请求不能都穿过“先 count 后 insert”。
4. 超额返回现有 quota envelope 风格的 409/403 结构化错误，包含 `resource`、`usage`、`limit`、`effectiveTier`。

不得通过：

- 到期时批量把 Space 改成 Free；
- 到期时删除多余 Space；
- 保留只允许一个 Free Space 的唯一索引然后捕获异常；
- 在 Renderer 预判后绕过服务端原子检查。

### 9.4 超额 UI

- Space Overview 继续展示 usage/limit；超额时显示 `usage / limit` 和“已超出当前套餐上限”。
- 禁用正增量按钮时，优先保留按钮并提供原因，而不是让入口神秘消失。
- API 拒绝后的文案：
  - “已达到当前套餐的成员上限。现有成员不会受影响，你可以先移除成员后再添加。”
  - “当前有 143 条未完成 Issue，免费版上限为 100。你仍可查看、评论和关闭 Issue；关闭到上限内后即可继续创建。”
- Phase 1 没有购买入口，不显示假 CTA；可显示“当前套餐：Free”与客观说明。

---

## 10. myagents.io/admin：「运营」Tab

### 10.1 一级导航

把 `AdminPage` 扩展为：

`'product' | 'space' | 'operations'`

顶部顺序：

1. 总体统计
2. MyAgents Space 统计
3. 运营

URL：

- `?page=operations` 进入运营页。
- 运营二级区使用 `section=accounts | plans | audit`，默认 `accounts`。
- 切换需更新 URL，支持刷新、浏览器前进/后退和分享内部链接。

日期选择器：

- 只在“总体统计”和“MyAgents Space 统计”显示。
- “运营”Tab 完全隐藏日期选择器，因为运营配置不是某个统计时间窗口。

运营页必须 lazy-load，避免进一步膨胀现有大型 Dashboard 初始 bundle。

### 10.2 页面结构

`OperationsWorkspace` 顶部：

- 标题：“Space 运营”
- 描述：“管理账号权益、查看套餐配置与追溯人工操作”
- 右侧只有克制的刷新动作，不放“新建配置”等含糊入口。

二级导航：

`账号权益　套餐权益　操作记录`

简单结构示意：

```text
┌ Space 运营 ───────────────────────────────────── 刷新 ┐
│ 管理账号权益、查看套餐配置与追溯人工操作               │
│ [账号权益] [套餐权益] [操作记录]                       │
├────────────────────────────────────────────────────────┤
│ 账号邮箱或 User ID [________________________] [查找]    │
│                                                        │
│ ┌ 账号身份与 owned Spaces ─────┐ ┌ Pro 操作 ─────────┐ │
│ │ 当前计划 / 有效期 / usage     │ │ 时长 / 到期预览    │ │
│ │ Space 1  usage / limit        │ │ 原因               │ │
│ │ Space 2  已超额               │ │ [授予/延长 Pro]     │ │
│ └───────────────────────────────┘ └────────────────────┘ │
│ 该账号操作历史                                         │
└────────────────────────────────────────────────────────┘
```

页面使用清晰分区与 divider，不堆叠统计 Dashboard 式 metric cards。主内容使用 `max-w-6xl`。

### 10.3 账号权益：查找

- 搜索框 label：“账号邮箱或 User ID”。
- 精确匹配，不做模糊搜索、自动补全或默认列出全部用户。
- Enter 与“查找”按钮等价。
- trim 输入；email 比较使用服务端统一 normalize。
- 未输入时按钮 disabled。
- 未找到时展示明确空结果，不把 404 当系统错误。
- 页面 URL 不放原始 email，避免浏览器历史与截图泄露；仅保留 section。账号 lookup 使用 JSON body，不把 email 放进 API query string。

默认空态：

> 输入账号邮箱或 User ID，查看该账号的套餐、有效期、owned Spaces 与运营记录。

### 10.4 账号摘要

找到账号后展示：

- avatar、姓名、email、User ID、创建时间。
- 当前有效套餐：Free / Pro。
- Pro 状态：有效、已到期、已撤销；无记录则不显示历史状态标签。
- 有效区间和精确到期时间。
- owned Spaces：`当前数量 / 当前限额`。
- 仅列该账号是 `billingOwnerUserId` 的 Space；加入他人的 Space 不属于本操作影响范围。
- 每个 Space 展示：
  - 名称与 slug
  - 成员、未完成 Issue、Skill、Agent、Storage 的 usage/limit
  - 超额项 badge
- 账号最近操作历史。

账号摘要与操作面板使用同一次权威读取；成功 mutation 后整体 revalidate。

### 10.5 授予 / 重新开通 Pro

适用：当前 effective tier 为 Free，包括从未开通、已到期或已撤销。

表单：

- 套餐固定为 Pro，不提供无意义下拉框。
- 快捷时长：1 个月、3 个月、6 个月、12 个月。
- “自定义到期时间”：显式选择本地日期和时间，旁边显示时区；默认时间为所选日期的 23:59。
- 生效时间只读：“立即生效”。
- 运营原因：必填，trim 后 1–500 字；placeholder 引导填写活动、工单或人工授权原因。
- 实时预览：
  - 开始时间
  - 到期时间
  - 覆盖时长
  - 将影响的 owned Space 数量
  - 生效后的每 Space quota

按钮：

- 无历史：“授予 Pro”
- 已到期/撤销：“重新开通 Pro”

### 10.6 延长 Pro

适用：当前 Pro 有效。

- 快捷时长从当前 `expiresAt` 起增加自然月。
- 自定义到期必须晚于现有 `expiresAt`。
- 预览同时显示“原到期时间 → 新到期时间”。
- 主按钮：“延长有效期”。
- 不创建第二条重叠 membership；更新当前记录并追加 event。

### 10.7 撤销 Pro

- 放在操作面板的次级危险区，不与主 grant/extend 按钮并列争夺注意力。
- 原因必填。
- 确认框明确显示：
  - 账号 email
  - 当前 Pro 到期时间
  - 将立即恢复 Free quota
  - 受影响 owned Space 数
  - “现有 Space 和内容不会删除；超额部分保留，但不能继续新增”
- 确认按钮：“确认撤销 Pro”。
- 撤销后 `revokedAt=now`，立即解析为 Free。
- 允许未来重新开通；审计链保留。

### 10.8 二次确认与提交

grant / regrant / extend / revoke 全部需要确认 dialog。

确认 dialog 必须展示：

- 目标账号
- 动作
- 原有效期
- 新有效期
- 受影响 Space 数
- 操作原因

提交规则：

- pending 时禁用表单和重复提交。
- 每次确认生成 `Idempotency-Key`。
- 携带读取时得到的 `expectedVersion`。
- 409 版本冲突时不自动覆盖；提示“该账号权益刚刚发生变化”，刷新后让管理员重新确认。
- 成功后关闭 dialog、显示简短 toast、刷新账号摘要并把新事件显示在历史第一行。
- 网络结果未知时用同一 idempotency key 重试，避免重复延期。

### 10.9 套餐权益

只读展示 Space Cloud 返回的 plan matrix：

- Free / Pro 对照表
- 每项 quota 的计算作用域与计数口径
- 文案：“套餐额度由 Space Cloud 版本配置管理；修改需经过代码评审与发布。”

本期不显示“编辑”按钮，避免暗示后台可热改全局商业规则。

### 10.10 操作记录

全局 append-only 表格：

- 时间
- 操作账号
- 动作
- 原有效期
- 新有效期
- 操作者
- 原因
- request ID（详情中展示）

筛选：

- 账号 email/User ID
- action
- operator
- 时间范围

采用 cursor 分页。默认最近操作优先，不受 Dashboard 日期 selector 影响。点击一行打开详情 drawer，展示 before/after projection 与 request ID，不允许编辑或删除。

---

## 11. 运营 API 与跨 Worker 安全边界

### 11.1 Space Cloud 路由

新增独立 route group：

`/api/admin/operations/*`

接口固定为：

#### Read

- `GET /plans`
- `POST /accounts/lookup`，body 为 `{ email }` 或 `{ userId }`（两者恰好一个）。它是无副作用查询，但用 JSON body 避免 email 进入 URL、浏览器历史和常规 access log。
- `GET /accounts/:userId`
- `GET /accounts/:userId/events?cursor=...`
- `GET /events?userId=&action=&operator=&from=&to=&cursor=...`

#### Write

- `POST /accounts/:userId/pro/grant`
- `POST /accounts/:userId/pro/extend`
- `POST /accounts/:userId/pro/revoke`

请求 body 不接受 `operatorEmail`。共有字段：

- `reason`
- `expectedVersion`（无 membership 时为 `null`）
- `durationMonths` 或 `expiresAt`，二者恰好一个（revoke 无此字段）

Space Cloud 根据动作决定基准时间并计算最终 `startsAt / expiresAt`；Website 不自行决定有效性。

### 11.2 独立 operations secret

新增 `SPACE_OPERATIONS_API_KEY`：

- `SPACE_ADMIN_API_KEY` 继续只允许 dashboard read。
- `SPACE_OPERATIONS_API_KEY` 保护 operations read/write。
- Space Cloud 新增 `requireSpaceOperationsApiKey`，不得把 write routes 挂到现有 read key middleware。
- Website Worker 的 secret binding 同名或明确映射，永不进入客户端 bundle/response/log。

理由：运营写权限能改变账号商业身份，风险显著高于统计读取；使用独立 secret 能让统计代理泄露时不自动获得写权限。

### 11.3 Website proxy

浏览器只访问同源：

`/api/admin/space/operations/*`

Website Worker：

1. 先通过现有 `requireAuth` / `ADMIN_EMAILS` 验证管理员。
2. 对所有 POST（包括无副作用的 account lookup）强制：
   - `Content-Type: application/json`
   - `new URL(Origin).origin` 必须等于 `new URL(request.url).origin`，从而同时支持 production 与 staging；缺失或不一致 fail closed
   - 只允许显式 allowlist 的 method/path
3. 读取服务端 auth context 中的管理员 email，写入可信 `X-MyAgents-Operator-Email`；覆盖/丢弃浏览器同名 header。
4. 使用 `SPACE_OPERATIONS_API_KEY` server-to-server 调 Space Cloud。
5. 明确转发 allowlist 内的 method、JSON body 和必要 query；mutation 透传 `Idempotency-Key`，全部请求透传或生成 `X-Request-Id`。
6. 使用 AbortController/既有 cancellable request pattern，设置明确超时。
7. 保留 Space Cloud 的结构化 envelope 与 HTTP status。
8. 所有 operations response 设置 `Cache-Control: no-store`；禁止 `withCache`、`caches.default` 和 5 分钟 edge cache。
9. 新建 `worker/routes/spaceOperations.ts`，不要复用当前只支持 GET、会解包并缓存数据的 `spaceDashboard.ts::proxyRoute`。

当前 Phase 1 所有 `ADMIN_EMAILS` 管理员都可操作；不新增角色表。审计必须记录实际 email，未来再按需要拆分只读/运营权限。

### 11.4 错误与并发

Space Cloud 必须区分：

- 400：字段/日期/原因错误
- 401：server-to-server secret 错误
- 403：操作员身份缺失或不合规
- 404：目标账号不存在
- 409：
  - expectedVersion 冲突
  - grant 一个仍有效的 Pro
  - extend 一个当前非有效 Pro
  - idempotency key 与不同 payload 冲突
- 429：运营接口限流
- 5xx：服务端错误，带 request ID

同一 idempotency key + 同一 payload 重试，返回第一次操作结果；同 key + 不同 payload 返回 409。

---

## 12. Session、Space projection 与桌面端权益展示

### 12.1 Session contract

`buildMeEnvelope` / Desktop `SpaceSession` 增加：

```ts
accountPlan: {
  effectiveTier: 'free' | 'pro';
  evaluatedAt: string;
  membership: null | {
    planTier: 'pro';
    status: 'active' | 'expired' | 'revoked';
    startsAt: string;
    expiresAt: string;
    revokedAt: string | null;
    source: string;
    version: number;
  };
}
```

Space 列表/当前 Space/Overview 的 plan projection 增加：

- `effectivePlanTier`
- `limits`
- `planExpiresAt`（当前有效 Pro 时）
- `usage`（Overview 已有则扩展，不重复事实源）
- `overages` 可由服务端返回或 Renderer 用同一响应的 usage/limits 纯展示计算

向后兼容：

- Cloud 先部署。
- Desktop 类型允许旧服务短暂缺少 `accountPlan` 时 fallback 为 Free 展示，但不能据此绕过服务端 quota。
- 新 Cloud 对旧 Desktop 保持既有字段可读。

### 12.2 权益刷新时机

服务端 quota 永远立即按 resolver 生效；Desktop 的展示通过以下既有节奏收敛，不新增常驻 plan poll：

1. grant / regrant / extend / revoke 成功后，Space Cloud 为该账号拥有的每个 user Space 写一条 `space.plan_changed` 事件：`resourceType='space'`、`resourceId=space.id`、`actorType='system'`；payload 只含 `effectiveTier`、`planExpiresAt` 与 membership `version`，不含运营原因或操作者。
2. 当前 Space 收到该事件时，`spaceStore` 失效当前 Space Overview 与 session projection，并做一次 silent revalidate。
3. 账户菜单打开时，如果 session projection 距上次远端校验超过 60 秒，先展示缓存值并发起一次 silent revalidate。这样即使当前停留在加入他人的 Space，也能更新本人账号身份。
4. active Pro 的账号/Space projection 都带 `expiresAt`；Desktop 在该时间点安排一次单次 revalidate。App 休眠错过 timer 时，在恢复前台或重新进入 Space 时补做。
5. 所有正增量 mutation 仍以服务端拒绝结果为准；不能因本地暂时显示 Pro 就绕过 quota。

`space.plan_changed` 必须加入 Space event 的共享类型、mock 与 event invalidation 测试。它不是 SSE 事件，不另建推送通道。

### 12.3 左下账户菜单

当前账户弹层扩为约 280px，并保持左侧栏内对齐。

顶部身份区：

- 40px avatar
- 姓名
- email
- 右上 badge：
  - active Pro：`PRO` 暖色 badge
  - Free：`FREE` 中性 badge
- 权益行：
  - active Pro：“专业版账户 · 有效至 2026年10月11日”
  - 距到期 ≤ 7 天：“专业版账户 · 还剩 N 天”并使用克制的提醒色
  - 从未 Pro：“免费账户”
  - 已到期：“免费账户 · Pro 已于 YYYY年M月D日到期”
  - revoked：只显示“免费账户”，不在用户侧暴露内部运营措辞

下方 divider 后保留账号设置、退出登录等既有动作。

禁止：

- 在菜单里放每个 Space quota meter。
- 放“立即升级”但实际不可购买。
- 把 Pro badge 放在当前 Space 名称旁，造成它是 Space 身份的误解。

### 12.4 Space Overview

Space Overview 负责展示当前 Space 的有效商业能力：

- `Pro · 有效至 …` 或 `Free`
- usage/limit
- 超额提示
- quota 计数口径的简短说明

如果当前用户只是加入他人 Space：

- 展示该 Space 的有效套餐，不宣称它来自当前用户账号。
- 不把当前用户自己的 Pro badge与该 Space quota 混在一起。

---

## 13. 数据库迁移与兼容

Space Cloud 新 migration 至少包含：

1. 创建 `account_plan_memberships`。
2. 创建 `account_plan_events`。
3. `account_plan_events.idempotency_key` 唯一索引。
4. `account_plan_events(user_id, created_at DESC)` 索引。
5. `account_plan_events(operator_email, created_at DESC)` 索引。
6. 为 `user_devices` 增加 `connector_last_seen_at`、`connector_online_until`。
7. 增加 `issue_comments(author_type, author_id, issue_id)`。
8. 增加 `issue_claims(actor_type, actor_id, issue_id)`。
9. 删除 `idx_spaces_free_user_space_per_owner`。

迁移规则：

- 不为现有用户回填 membership；无行自然是 Free。
- 不改变已有 Space、成员、Issue、Skill、Agent 或 storage 数据。
- 不把 `spaces.plan_tier` 批量改值；它可暂留兼容，但不再参与有效 quota 判断。
- presence 新字段默认 NULL，旧设备/Agent 首次展示为离线。
- migration 要可在已有 staging/prod 数据上执行，并在测试中覆盖重复运行/目标 schema。

---

## 14. Store、事件与缓存

### 14.1 Desktop

- `spaceStore` 继续是 Space UI 数据 owner。
- Account plan 随 session 更新，不另建全局商业状态 store。
- `related` 必须进入 query key，避免“相关”和“全部”错误共用缓存。
- 本人 mutation 可 patch + sort。
- 远端 event 只标记当前查询有新版本；点击 banner 后 force refresh。
- Agent presence silent refresh 不写 event cursor，不刷新无关 Issues/Skills。
- 登记/启用 Agent 后的“连接中”是本地过渡态；最终 online 以 Cloud projection 为准。

### 14.2 Website

- 运营 API 建独立 hook/client，不把 mutation 硬塞进只读 `useDashboardData`。
- read account result 可在当前组件内短暂缓存；任何 mutation 成功后强制 revalidate。
- operations 全部 no-store，浏览器刷新必须拿到当前有效期。
- 切换到其他主 Tab 后可卸载账号敏感数据。

### 14.3 Space Cloud

- plan resolver 在请求作用域 memoize，不能在同一路由反复查询 membership。
- 运营账号详情使用有限、可索引的聚合查询；禁止为每个 Space × 每种 resource 发 N+1。
- presence touch 是单行 update，不产生 Space event。
- “与我相关”用 server-side query + cursor，不把完整 ID 集合返回客户端。

---

## 15. 完整交互状态

### 15.1 Issues / Skills

- 首载：贴近真实行高的 skeleton。
- 后台刷新：旧内容保留。
- 空结果：
  - 普通：“暂无 Issue”
  - 相关筛选：“没有找到与你相关的 Issue”
  - 组合筛选：“没有符合当前筛选条件的 Issue”
- 错误：当前区域展示错误与重试；不清空旧列表。
- 远端更新：inline banner，不用 toast 风暴。
- 时间：本地化、可访问、tooltip 有绝对时间。

### 15.2 Agents

- 首次没有 presence：离线/尚未在线。
- connector 网络失败：lease 到期后离线；不把旧的绿色状态永久保留。
- disabled：明确“已停用”，提供重新启用。
- 添加成功：连接中；超时后离线并给出“确认 MyAgents 客户端正在运行并能访问 Space Cloud”的排查说明。
- 列表 revalidate 失败：保留旧卡片，同时提示“在线状态可能不是最新”。

### 15.3 运营页

- 首屏：账号查找引导。
- 搜索中：搜索框保持内容，结果区 skeleton；禁止重复搜索。
- 未找到：明确空态。
- 账号加载失败：就地重试。
- 提交中：dialog 不可关闭或明确提示处理中；按钮 spinner。
- 成功：toast + 权威结果刷新。
- 409：保留输入原因，刷新账号状态，让管理员重新确认日期。
- 结果未知：提示可安全重试，不擅自宣称失败。
- audit 无记录：显示“暂无人工运营记录”。

---

## 16. i18n、可访问性与文案

Desktop 所有新增文案进入现有 zh-CN / en-US Space i18n namespace；禁止 JSX 硬编码。Website Admin 当前若尚未建立 i18n，可延续后台中文，但文案集中为常量/组件语义，不在请求层散落。

关键中文：

| 场景 | 文案 |
|---|---|
| Issue toggle | 与我相关 |
| 远端列表更新 | 有更新，点击刷新 |
| Agent add | 添加本机 Agent 工作区 |
| Agent online | 在线 |
| Agent offline | 离线 |
| Agent disabled | 已停用 |
| Agent transition | 连接中 |
| Pro badge | PRO |
| Free badge | FREE |
| Operations tab | 运营 |
| Operations title | Space 运营 |
| Operations sections | 账号权益 / 套餐权益 / 操作记录 |
| Grant | 授予 Pro |
| Regrant | 重新开通 Pro |
| Extend | 延长有效期 |
| Revoke | 撤销 Pro |

可访问性：

- toggle 使用 `aria-pressed`。
- 在线/离线不可只靠颜色。
- account badge 有可读 label。
- 所有 icon-only button 有 `aria-label` 和 tooltip。
- dialog 初始焦点、Escape、focus trap、关闭层级遵守现有组件规范。
- 表单 error 与字段通过 `aria-describedby` 关联。
- 操作记录表头、排序与 drawer 触发可键盘访问。

---

## 17. 安全、隐私与审计

1. Website 浏览器永远看不到 `SPACE_OPERATIONS_API_KEY`。
2. Space Cloud 不信任 body/header 中由浏览器直接提供的 operator；只信任通过 operations bearer secret 的 Website Worker 注入值。
3. Website mutation 强制 same-origin、JSON、allowlist path/method。
4. 所有 operations response no-store；账号邮箱不进入 URL query/history。
5. 原因必填，不能只写空审计。
6. 权益 mutation 与 audit event 原子提交。
7. idempotency 防 double click、网络重试和代理超时造成重复延期。
8. optimistic version 防两个管理员相互覆盖。
9. 操作记录不可在 UI 删除或编辑。
10. 日志避免完整 dump before/after JSON、token、secret；使用 request ID 和 event ID 排障。
11. account lookup 必须精确匹配并受 admin auth；不提供公开用户枚举。
12. presence endpoint 不接受客户端自报 owner/device ID，避免把其他设备伪造为在线。
13. online 是短 lease，不是永久布尔值；失联自然过期。

---

## 18. 分仓实现蓝图

### 18.1 MyAgents_space

按领域拆分，禁止继续把所有逻辑塞进 `src/index.ts`：

- plan types/config：扩展 `src/constants.ts`。
- plan resolver / quota context：`src/services/planEntitlements.ts`。
- operations auth：扩展 `src/services/adminAuth.ts`，新增 `requireSpaceOperationsApiKey`。
- operations routes：独立 `src/routes/operations.ts`。
- operations service：`src/services/spaceOperations.ts`，拥有账号 lookup、grant/extend/revoke、audit。
- presence service：`src/services/devicePresence.ts`，继续由现有 Registered Agent token auth 进入。
- Issue related SQL：在现有 issue list builder 中增加条件，不复制一套列表 endpoint。
- migration 与 route tests 同步。

需要替换的旧判断：

- 所有直接 `SPACE_PLAN_LIMITS.free` 的 quota 路径。
- 所有依赖 `spaces.plan_tier` 判 quota 的路径。
- user Space create 的静态 unique-index 错误分支。
- Agent serializer 用普通 `last_seen_at` 或配置 `updatedAt` 表示在线的路径。

### 18.2 MyAgents Desktop

- `spaceCloud.ts`：扩充 contract、Issue query、presence projection。
- `spaceUi.ts`：拆分 collection/reading/form width token。
- `spaceHelpers.ts`：query params/key 与 Agent UI helper。
- `spaceStore.ts`：related cache、remote-update banner state、own mutation sort、Agent silent refresh。
- `IssuesWorkspace.tsx`：toggle、工具栏换行、updatedAt、banner。
- `SkillsWorkspace.tsx`：updatedAt、banner、6xl。
- `AgentsWorkspace.tsx`：online/offline/disabled、lastOnlineAt、排序、连接中、文案。
- `SpaceSettingsWorkspace.tsx`：只对 Members 集合使用 6xl，Overview/roles/form 保持阅读宽度；plan/overage。
- `SpaceChrome.tsx`：账户菜单身份头部。
- Rust `space_cloud.rs`：connector 按设备分组、节流 presence touch、API projection/mock。
- i18n 与 tests 同步。

### 18.3 MyAgents_web

- `Dashboard.tsx`：扩展 `AdminPage`、tab、URL、条件显示 day selector、lazy operations。
- 新增 `src/pages/admin/OperationsWorkspace.tsx` 及 accounts/plans/audit 子视图。
- 新增 operations API client/hook，读写分离。
- Worker 新增 `worker/routes/spaceOperations.ts`，在 `worker/index.ts` 挂载 `/api/admin/space/operations/*` proxy。
- Env 类型/部署 secret 增加 `SPACE_OPERATIONS_API_KEY`。
- mutation proxy 注入 operator email、origin check、no-store、timeout、structured envelope。
- admin UI tests / Worker route tests 同步。

---

## 19. 开发顺序与发布策略

### Phase A：Space Cloud 基础

1. migration：membership/events/presence/index/drop old unique index。
2. Free/Pro config 与 resolver。
3. quota 全链路改用有效 plan。
4. accountPlan / effective Space plan contract。
5. operations API、auth、audit、idempotency。
6. `related=me` 查询。
7. device presence 与 Agent projection。
8. route/unit/integration tests。

Cloud 必须先做到向后兼容再部署 staging。

### Phase B：Website Admin 运营页

1. operations server proxy 与 secret。
2. 账号权益 UI。
3. 套餐权益只读页。
4. 操作记录。
5. staging 上真实 grant/extend/revoke 验证。

### Phase C：Desktop

1. contract 与 Rust connector。
2. Issue/Skill query、时间、更新提示。
3. Agent UI。
4. widths / narrow layout。
5. account menu / Overview。
6. mock/i18n/tests。

### Phase D：联调与发布

部署顺序：

1. MyAgents_space staging
2. MyAgents_web staging/admin
3. Desktop staging/debug
4. 三仓联合验收
5. MyAgents_space production
6. MyAgents_web production（用户确认后）
7. Desktop 0.2.50 release

回滚：

- Website UI 可独立回滚；Space operations API 保留。
- Desktop 可回滚，Cloud 新字段保持兼容。
- Cloud 不通过删除 membership 数据回滚；若必须关闭运营写入口，撤销 operations secret/binding，resolver 仍正确读取已有记录。

---

## 20. 验收标准

### 20.1 Issues

- [ ] “与我相关”能命中本人创建、评论、曾 claim 的 Issue。
- [ ] 能命中当前账号拥有的 Agent 创建、评论、曾 claim 的 Issue。
- [ ] cancelled/completed claim 仍命中。
- [ ] disabled/revoked Agent 的历史行为仍命中。
- [ ] 与状态、目标、子树、搜索、humanOnly 正确 AND。
- [ ] cursor 多页无漏项、无重复、顺序稳定。
- [ ] 切 Space 后各自保留当前 Tab session 的 toggle；App 重启默认关闭。
- [ ] Issue/Skill 展示 updatedAt，日期能解释列表顺序。
- [ ] 本人 mutation 立即重排；远端 event 只显示更新提示，点击后重排。

### 20.2 Layout / visual

- [ ] Issues、Skills、Agents、Members 在宽屏使用 6xl。
- [ ] Overview、Roles、表单没有被无条件拉到 6xl。
- [ ] 800×600 下筛选栏两行可用，无重叠、裁切或极窄控件。
- [ ] 所有新状态使用设计 token、七档字号、可访问文字。

### 20.3 Agents

- [ ] active 不再等于 online。
- [ ] 普通 `last_seen_at` 与配置 `updatedAt` 不会被显示为 connector 在线。
- [ ] 同一设备多个 Agent 一次 connector 周期只做一次 presence touch。
- [ ] delivery GET 仍为纯读。
- [ ] lease 到期自动离线。
- [ ] disabled 卡片置灰且显示“已停用”。
- [ ] online/offline/disabled 排序正确，页面停留时 badge 更新不跳位。
- [ ] 添加/重新启用先显示连接中，最终以 Cloud presence 收口。
- [ ] 所有登记入口统一为“添加本机 Agent 工作区”。

### 20.4 Pro / quota

- [ ] Free/Pro quota 与 `8.1` 完全一致。
- [ ] Pro 账号最多创建 5 个 owned Spaces；Free 最多 1 个。
- [ ] Pro 自动覆盖其 billing-owned Spaces，不影响加入的他人 Space。
- [ ] 有效期边界严格为 `[startsAt, expiresAt)`。
- [ ] 1/3/6/12 月按自然月、月末规则正确。
- [ ] active 延期从现有 expiresAt 起算；expired/revoked 从 now 起算。
- [ ] 到期无需 cron，下一次请求立即解析为 Free。
- [ ] 到期后既有对象全部可读、Agent 可继续运行。
- [ ] 每类 quota 只拦正增量，释放配额动作始终允许。
- [ ] 并发 Space 创建不能突破 ownedSpacesMax。
- [ ] official Space 豁免不受账号 Pro 影响。

### 20.5 Operations

- [ ] myagents.io/admin 顶部有“运营”，URL 可恢复。
- [ ] 运营页不显示统计日期 selector。
- [ ] 能按精确 email/User ID 找账号，不默认枚举用户。
- [ ] 能授予、重新开通、延期、撤销 Pro。
- [ ] 提交前展示精确前后有效期、影响 Space 和原因。
- [ ] 所有写入有 operator、reason、before/after、request ID、idempotency key 审计。
- [ ] double click/重试不会重复延长。
- [ ] 版本冲突不会覆盖另一位管理员操作。
- [ ] operations 全部 no-store，secret 不进入浏览器。
- [ ] 套餐权益显示 Space Cloud 权威数值且无虚假编辑入口。
- [ ] 账户菜单和 Space Overview 在操作成功后展示真实权益。

---

## 21. 测试与验证

### 21.1 MyAgents_space

#### Plan resolver unit tests

- 无 membership -> Free。
- startsAt 前 -> Free。
- startsAt 精确时刻 -> Pro。
- expiresAt 前 1ms -> Pro。
- expiresAt 精确时刻 -> Free。
- revokedAt 非空 -> Free。
- 1/3/6/12 自然月与闰年/月末。
- active extend、expired regrant、revoked regrant。
- official Space quota bypass。

#### Operations route tests

- operations secret 缺失/错误/正确。
- dashboard key 不能调用 operations write。
- operator header 缺失。
- exact email 与 User ID lookup。
- grant/extend/revoke happy path。
- reason/date validation。
- expectedVersion conflict。
- idempotency 同 payload重放、不同 payload冲突。
- membership 与 event 原子性。
- audit cursor/filter/order。

#### Quota integration tests

- Free/Pro 每类上限。
- Pro 到期后存量读取。
- 成员/Issue/Skill/Agent/Storage 正、零、负增量矩阵。
- revoked restore 与 disabled re-enable 差异。
- 并发 Space create。
- 旧 `plan_tier` 不影响 effective plan。

#### Related query tests

- 六种关系分别命中。
- cancelled/completed claims。
- revoked Agent 历史。
- 其他用户/其他账号 Agent 不命中。
- AND filters。
- cursor 跨页与稳定排序。
- 查询计划使用新增索引，压测种子下无明显退化。

#### Presence tests

- token 推导 owner/device，拒绝 body spoof。
- active token touch。
- revoked/invalid token 拒绝。
- 一个 device projection 到多个 active Agents。
- disabled override。
- lease boundary。
- delivery GET 不写任何 presence 字段。

### 21.2 MyAgents Desktop

- `spaceHelpers`：related query key/normalize。
- `spaceStore`：不同 related 缓存隔离、own mutation sort、remote stale banner。
- Issues DOM：toggle aria、AND params、窄窗结构、空/错/刷新。
- Skills DOM：updatedAt 与更新 banner。
- Agents DOM：online/offline/disabled/connecting、排序、lastOnline 文案。
- Account menu DOM：Free/Pro/临期/已到期。
- Settings DOM：6xl 只作用于 Members；Overview overage。
- Rust：device group/coalesce/throttle、token fallback、presence failure 不阻断 delivery。
- mock contract 与 production contract 一致。

执行：

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:dom
npm run test:changed
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D clippy::disallowed_methods -D clippy::disallowed_macros
```

按改动补充对应 Rust tests；完整发布前跑仓库规定的非 credentialed 全池。

### 21.3 MyAgents_web

- `AdminPage` URL parsing/导航。
- operations 页隐藏 day selector。
- exact lookup 与所有空/错/loading 状态。
- grant/extend/revoke 表单与日期预览。
- confirmation、pending、409、safe retry。
- audit drawer。
- Worker auth、origin、JSON、path allowlist。
- operator 覆盖浏览器伪造 header。
- operations key 不泄露。
- no-store / no edge cache。
- upstream timeout 与 envelope/status 透传。

执行该仓库定义的 typecheck、lint、test、build；不得假设与 Desktop 使用同一脚本。

### 21.4 三仓联合验收脚本

1. 创建 Free 测试账号，确认 1 Space / 3 members / 100 issues / 50 skills / 6 agents / 1 GB。
2. 在 admin 运营页搜索账号，授予 1 个月 Pro。
3. Desktop 刷新 session，账户菜单出现 PRO 和有效期；owned Space Overview 显示 Pro quota。
4. 创建第二个 Space，验证成功。
5. 让本人和账号下 Agent 分别创建、评论、claim Issue；验证“与我相关”六类命中。
6. cancel/complete claim，验证仍命中。
7. 同一客户端绑定两个 Agent，connector poll 后两者 online，云端只发生一次 device presence touch。
8. 停用其中一个，卡片显示已停用；另一个保持在线。
9. 人为把 expiresAt 调到当前时间前，刷新：账户变 Free、两个 Space 都保留。
10. 在超额 Space 中验证读、评论、关闭、删除允许；新增/扩容拒绝。
11. 从 admin 重新开通，额度立即恢复。
12. 检查 account audit 与 global audit 完整。

---

## 22. 可观测性

Space Cloud 增加不含敏感内容的结构化指标/日志：

- `space_plan_resolve`：effective tier、source（fallback/membership/official）、duration。
- `space_quota_rejected`：resource、effectiveTier、usage、limit、operation。
- `space_operation_completed`：action、operator hash/email（按现有日志隐私规范）、target user ID、event ID、request ID。
- `space_operation_conflict`：version/idempotency reason。
- `device_presence_touch`：device ID hash、lease、result；采样或聚合，避免高频日志成本。
- `issue_related_query`：是否开启、duration、result count；不记录搜索正文。

Website 记录 proxy request ID、status、duration，不记录 secret、reason 全文或 before/after JSON。

核心上线观察：

- operations 5xx / 409 / duplicate retry。
- quota reject 按资源分布。
- presence write QPS 是否接近活跃设备数而不是 Agent 数。
- related query p95 与 D1 rows read。
- Pro 到期后是否出现错误删除/隐藏（应为 0）。

---

## 23. 关键决策与 rationale

### D1：Dashboard 后置

它是长期正确方向，但不是本期“把已有工作流做准”的前置条件。没有半成品入口，也不提前建 Dashboard 数据层。

### D2：“与我相关”是历史经办关系

claim 表达已经发生的执行关系，不是当前锁。取消 claim 不能抹掉“我处理过”；状态过滤负责回答“现在是否未完成”。

### D3：关系筛选必须服务端完成

Issue 列表有 cursor/limit；前端过滤当前页会漏数据，结果不可相信。服务端关系表已经足够，不创建新的冗余关系对象。

### D4：在线 owner 是客户端设备

一个 MyAgents 客户端维护多个 Agent harness；逐 Agent heartbeat 重复表达同一事实。设备级 lease 才符合真实生命周期与 Pro 容量模型。

### D5：delivery poll 保持纯读

容量 PRD已经把该 endpoint 定义为纯读。独立、合并后的 presence touch 让读路径语义清楚，也避免每个 Agent 请求都写 D1。

### D6：账号是会员 owner，Space 是 quota owner

账号身份回答“谁有 Pro”；`billingOwnerUserId` 回答“哪个账号为这个 Space 承担额度”；Space usage 回答“资源在哪里消耗”。三者各自只有一个职责。

### D7：到期按请求时间解析

有效期天然是时间函数。cron 翻状态会产生延迟、失败与双重事实；请求时解析 `[startsAt, expiresAt)` 更简单且正确。

### D8：软降级只拦正增量

quota 是容量上限，不是历史内容的惩罚开关。保留读/运行/删减能力，才能既保护成本又维持用户信任。

### D9：运营能力进入现有 admin

它是 MyAgents Space 的业务运营能力，不值得另建孤立后台。现有 admin 已有安全认证和 Space 统计上下文；新增主 Tab 让数据观察与人工操作在同一管理面，但写权限仍用独立 secret 隔离。

### D10：套餐权益一期只读

后台热改全局 quota 会让商业规则脱离代码 review、测试与版本。现阶段确定两档固定权益，运营真正需要的是账号授权；动态套餐编辑应等定价版本化需求出现后再设计。

### D11：列表扩宽不等于所有页面扩宽

集合页需要信息密度，阅读页需要舒适行长。拆分 frame token 比全局把 `SPACE_LIST_FRAME_CLASS` 改成 6xl 更符合任务语义。

### D12：Pro 展示属于账户身份

左下账户菜单是账号身份的自然 owner；Space Overview 只展示该 Space 的有效 quota。两处信息互补但不能混淆。

---

## 24. 后续版本候选

- Space Dashboard：需要我处理、Agent 执行中、目标进展、最近变化。
- Issue 关注/Watch，与“我参与过”分开。
- 付费订阅、支付、续费、账单与宽限期。
- versioned plan catalog、历史订阅保留权益、动态套餐编辑。
- 运营权限角色拆分、审批流、批量赠送、活动码。
- Pro 到期邮件/站内提醒。
- Agent 执行态（idle/running/error）与 online 的第三轴可视化。
- 筛选器保存、快捷视图、批量 Issue 操作。

这些方向都不得在 0.2.50 以空入口、隐藏字段或半成品 UI 预埋。

---

## 25. 完成定义

只有同时满足以下条件，0.2.50 本需求才算完成：

1. 三仓实现与测试全部通过，各自提交清晰、无敏感信息。
2. “与我相关”、updatedAt、6xl、Agent presence、Pro identity、quota、运营后台形成同一套真实端到端行为。
3. 不存在 Website/Renderer 复制套餐数值、客户端计算 online lease、静态 `spaces.plan_tier` 决定 quota 等第二事实源。
4. Pro 到期和超额矩阵通过联合验收，存量零删除、零隐藏。
5. 运营写操作满足独立 secret、trusted operator、原因、二次确认、幂等、并发冲突和 append-only audit。
6. 800×600 Desktop、常规宽屏与 Website 1024px 三档视觉完成实机截图验收。
7. `specs/tech_docs/space_cloud.md`、相关架构/设计文档在实现后按真实代码更新，不能让 PRD 成为唯一长期文档。

---

## 执行台账

> 本节由 `/start-dev` 在 2026-07-11 建立。它既记录实现进度，也约束实现期间不得偏离的架构边界。每个阶段只有在代码、测试、独立 review 与分仓提交全部完成后才能标记完成。

### A. 开发前实现契约

#### A.1 Must-win outcomes

1. Space Cloud 成为账号 Free / Pro 有效权益、所有 Space quota、Issue「与我相关」关系和设备在线状态的唯一业务权威。
2. Free / Pro 配额分别严格落为：
   - Free：1 owned Space / 3 members / 100 open Issues / 50 Skills / 6 Registered Agents / 1 GiB。
   - Pro：5 owned Spaces / 20 members / 1000 open Issues / 300 Skills / 40 Registered Agents / 20 GiB。
3. Pro 会员支持 1 / 3 / 6 / 12 个 UTC 自然月与自定义到期日；有效区间为 `[startsAt, expiresAt)`；到期后按请求时间自然回落 Free，无 cron 翻状态。
4. 降级或到期后存量始终可读、可运行、可关闭和可删减；只拒绝使受限资源继续正增长的操作，绝不自动删除、隐藏或停用存量。
5. `related=me` 必须在服务端与状态、目标、搜索做 AND 组合，并覆盖本人/本人账号下 Agent 的创建、评论、历史 claim 六类关系；claim 完成或取消后关系仍保留。
6. Registered Agent 的主状态来自设备级 connector presence：在线 / 离线；启用 / 停用只作为管理轴。delivery GET 保持纯读，同一设备一次合并 touch 可投影到其全部 Agent。
7. Website Admin 新增「运营」主 Tab，集中提供账号精确查询、授予/重新开通/延期/撤销、固定权益只读查看和全局/账号操作审计；浏览器永远接触不到 operations secret。
8. Desktop 完成 Issues「与我相关」、Issue/Skill `updatedAt`、集合页 6xl、远端更新提示、Agent 双轴状态、账户菜单 Pro 身份和 Space Overview 真实 quota 的统一体验。
9. 三仓各自通过与改动风险相称的 typecheck、lint、测试和构建；800×600 Desktop、常规宽屏及 Website 1024px 完成视觉验收。

#### A.2 必须复用的既有抽象

- Space Cloud：`createPrimaryDb()` / request-scoped `SpaceDb` bookmark、D1 `batch()` 原子事务、既有 user/agent auth、`prepareEventInsert()` / Space event stream、`pollPolicy.ts` 环境配置、统一 `{ success, data }` envelope。
- Desktop Rust：既有 `SpaceConnectorSchedule`、connector run lock、delivery polling/backoff、registered-agent token 和 Rust HTTP 边界；presence 必须搭载在现有 delivery 调度周期中，不建立第二条后台循环。
- Desktop Renderer：`spaceCloud.ts` typed wrapper、`spaceStore`、现有 15 秒 Space event polling、`useCloseLayer` / `OverlayBackdrop`、Space i18n namespace 和 Design tokens。
- Website：现有 Google admin session / `requireAuth` 白名单、同源 Worker proxy、Admin 顶部页签、设计 token 与错误/加载组件。
- 权益解析必须显式“一次解析、向下传递”；列表/账户快照使用批量解析，禁止为每个 Space 产生隐式 N+1 查询。

#### A.3 反向边界（必须保持为零）

- Renderer 不得直接访问 Space Cloud HTTP，也不得持有 registered-agent token 或 operations secret。
- Website 浏览器不得直连 Space Cloud operations API；Website Worker 不得直读 Space D1。
- `SPACE_ADMIN_API_KEY` 不得获得写权限；运营写请求只接受独立的 `SPACE_OPERATIONS_API_KEY`。
- delivery GET 不得顺带写 presence；在线 lease 不得由 Desktop 或 Website 自行计算。
- `spaces.plan_tier` 不得继续作为 quota 权威；Website / Desktop 不得复制 Free / Pro 配额常量作业务判定。
- Pro 到期不得通过 cron、批量 Space 改写、`active` 布尔值或内容清理表达。
- 「与我相关」不得在前端对当前 cursor 页二次过滤，也不得新增冗余 issue-relation 表。
- 远端列表事件不得让用户正在浏览的列表静默跳位；本地成功写入则必须立即按 `updatedAt DESC, id DESC` 重排。
- 本期不得预埋 Dashboard、关注、付费/账单、动态套餐编辑或 Agent 运行态等后续概念。

#### A.4 本期新增概念及其必要性

| 新概念 | 必要性 | 控制复杂度的方式 |
|---|---|---|
| `account_plan_memberships` | 账号级会员与有效期需要唯一持久 owner | 每账号一行；有效性由时间函数解析，不增加状态机 |
| `account_plan_events` | 人工运营写操作必须 append-only、可审计、可幂等重放 | 事件只由 operations service 写；读取与业务会员表分离 |
| membership `last_event_id` | D1 batch 中把 CAS 会员变更和审计事件绑定为同一个原子结果 | 仅作内部事务关联，不暴露成产品状态 |
| event `request_hash` | 同一 idempotency key 重试需要区分“同请求重放”和“不同请求冲突” | 对规范化 mutation payload 哈希，不保存 secret |
| device connector presence 字段 | Agent 在线事实由维护 harness 的 MyAgents 客户端设备拥有 | 复用 `user_devices`，不新建 heartbeat 实体或 per-Agent heartbeat |
| `effectivePlan` 投影 | Desktop/Website 需要显示同一个当前权益事实 | 只由 Cloud 返回；客户端只展示，不推导 |

除上表与 PRD 已定义对象外，不新增新的长期业务概念。若实现中发现必须扩展，先更新本契约并写明删除不了该概念的原因。

#### A.5 本期触及的项目红线

- 任何设计/跨模块改动必须继续服从 `specs/ARCHITECTURE.md`；Space Cloud 不是 Sidecar/AI Runtime。
- Renderer Space HTTP 继续经 Rust/Tauri；不新增 WebView 原生 fetch。
- 前端颜色、字号、圆角与阴影复用 Design tokens；不写任意 px 字号、不用原生 `<select>`。
- 新增可关闭层继续注册 `useCloseLayer`，遮罩用 `OverlayBackdrop`；React effect 保持稳定引用和正确 cleanup。
- 用户可见文案进入中英文 i18n；状态不只依赖颜色表达。
- D1 写入走既有 DB facade 与原子 batch；Space 创建、quota 与 operations 不允许 check-then-write race。
- Rust connector 不增加裸 `reqwest::Client::new()`、裸 `tokio::spawn` 或阻塞 Tauri command。
- Website operations proxy 必须严格 path allow-list、JSON-only、`Cache-Control: no-store`、30 秒超时，并由服务端注入已认证 operator email。
- `MyAgents_web` 发布分支会自动部署：本阶段只在功能分支提交，未经用户验收不合并、不推送生产分支。

### B. 分阶段进度

#### Phase A — Space Cloud 业务权威

- [x] 新增 migration：账号会员/审计、设备 presence、必要索引，移除静态 Free owned-Space 唯一索引。
- [x] 建立计划权益、自然月、批量 usage/quota、operations、device presence 的单一 owner service。
- [x] 所有 quota 写路径改用 effective plan，并实现正增量软降级与原子 Space 创建。
- [x] `related=me` 六类关系与组合筛选。
- [x] Registered Agent presence 投影、独立 touch endpoint 与动态 lease。
- [x] operations API：独立认证、lookup/plans/audit/grant/regrant/extend/revoke、幂等/CAS/审计。
- [x] unit + route + performance regression 测试、typecheck、完整 test、独立 cross-review、分仓 commit。

#### Phase B — myagents.io/admin 运营台

- [x] 顶部新增 `运营`，支持 `?page=operations&section=accounts|plans|audit`；运营页隐藏日期选择器。
- [x] 无缓存 operations proxy：same-origin auth、路径白名单、JSON-only、operator 注入、独立 secret。
- [x] 账号查询、会员详情/Space 超额、授予/重新开通/延期/撤销预览确认、套餐只读、全局/账号审计 UI。
- [x] 1024px 响应式与键盘/错误/重复提交体验。
- [x] typecheck、lint、build、独立 cross-review、分仓 commit；未触发生产发布。

#### Phase C — Desktop Team Space 体验

- [x] Rust connector 在既有 poll 周期按设备合并 presence touch；失败不污染 delivery 成功语义。
- [x] Space API 类型接入 account/effective plan、presence、related 参数。
- [x] Issues「与我相关」与现有筛选 AND；Issue/Skill 展示/排序 `updatedAt`。
- [x] 自己操作即时重排；远端事件只提示“有更新”，用户确认后刷新。
- [x] Issues/Skills/Agents/Members collection frame 6xl，阅读/表单保持窄宽。
- [x] Agent 在线/离线主轴、停用视觉、connecting 过渡、稳定排序与新登记文案。
- [x] 左下账户菜单 Free/Pro 会员卡、过期刷新；Space Overview 真实 quota/有效期/超额。
- [x] 单元/DOM/Rust 测试、typecheck、lint、受影响测试、独立 cross-review、路径限定 commit。

#### Phase D — 联调、视觉验收与文档收口

- [x] 按 §21.4 的场景完成 Cloud route/unit、Website Worker/build、Desktop mock/DOM/Rust 的三仓契约回归，覆盖到期、超额、claim 历史与同设备多 Agent；真实部署账号的人工端到端脚本留到发布验收。
- [ ] Desktop 800×600 / 常规宽屏、Website 1024px 实机截图检查：本轮无可用浏览器视觉后端，须在合并发布前人工完成。
- [x] 运行三仓最终验证与 diff/敏感信息/未提交文件审计。
- [x] 更新 `specs/tech_docs/space_cloud.md`；本期没有改变主架构或设计 token，不需要改写 `ARCHITECTURE.md` / `DESIGN.md`。
- [x] PRD frontmatter 标为 `implemented`，补齐各阶段 commit/review/测试证据和最终接受摘要。

### C. 当前执行记录

| 时间 | 阶段 | 记录 |
|---|---|---|
| 2026-07-11 | 开发前审计 | 完整重读本 PRD、主仓 `ARCHITECTURE.md` / `DESIGN.md` / `space_cloud.md` / React 稳定性 / i18n 文档，并审计三仓源码、迁移、测试与工作区状态。主仓已有大量与本需求无关的用户改动，后续只做路径限定提交；Space 与 Web 已分别建立 `dev/0.2.50-space-pro-operations`、`dev-space-pro-operations` 功能分支。 |
| 2026-07-11 | 架构收敛 | 确认权益解析显式批量下传；Space 创建使用 D1 条件写原子门控；operations 以 membership CAS + `last_event_id` + append-only event 保证原子审计，以 `request_hash` 保证安全幂等；presence 复用既有 connector 调度，不增加新循环。 |
| 2026-07-11 | Phase A 完成 | Space Cloud 在 `dev/0.2.50-space-pro-operations` 提交 `c1f2f19 feat(space): add Pro operations and atomic quotas`。54 项测试通过、1 项按环境跳过，typecheck 与性能回归通过；独立 review 关闭原子 quota、审计幂等、自然月边界、presence lease 与 related 查询问题。 |
| 2026-07-11 | Phase B 完成 | Website 在 `dev-space-pro-operations` 提交 `0f5ccbd feat(admin): add Space operations workspace`。typecheck、lint、生产 build 与 Wrangler dry-run 通过；独立 review 确认浏览器不接触 operations secret、写请求 no-store、路径白名单、trusted operator、错误状态与确认流程。 |
| 2026-07-11 | Phase C 完成 | Desktop 在 `dev/0.2.50` 完成 related 独立筛选、cursor 分页与 keep-previous-data、updatedAt、6xl、设备 presence、Free/Pro 身份、Overview quota 与完整 mock。两轮架构/对抗 review 和最终 UX 复审均已关闭，最终无 Critical / High / Medium。 |
| 2026-07-11 | 最终验证 | Desktop `npm run typecheck`、`npm run lint`、`npm test`、`npm run build:web`、Rust 31 项 Space 定向测试、目标 Rustfmt 与完整 Clippy 均通过；最终 Store unit 37/37、相关 DOM 14/14（Issues 5/5）。lint 仅保留既有 `chatSuggestions.ts` orphan warning，Clippy 仅输出仓库既有 warnings。Space / Web 工作区 clean；Desktop 只路径限定暂存本 PRD 范围，保留用户的其他未提交改动。 |
| 2026-07-11 | 视觉验收说明 | 已完成源码级 UI/UX 复审、响应式断点与 DOM 交互回归；本轮 in-app browser 无可用页面，未伪造 800×600 / 常规宽屏 / Website 1024px 截图。真实运行视觉验收作为合并发布前唯一待办。 |

### D. 待用户决策

无。产品决策已在正文收敛；实现期间只有出现会改变本文业务语义或引入新长期概念的事实，才暂停请求决策。
