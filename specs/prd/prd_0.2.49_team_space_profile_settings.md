---
type: prd
status: implemented
created: 2026-07-05
updated: 2026-07-05
scope: "Team Space 登录用户资料设置：补齐昵称、头像、只读 Email、左下角账户菜单与设置 overlay；Google 登录头像作为默认头像，用户本地上传后写入公开 R2 直链；Issue / 评论 / Skill 上传人展示小圆形头像。不做头像移除、成员资料页、多 Space 资料体系或 Registered Agent 头像设置。"
issue: "产品需求：Team Space 登录用户基础身份设置"
research: ""
review: "cross-review-code 已完成：三路 reviewer 发现并已修复 avatar-only 错标 name_source、头像预览绕过 workspace file service、Rust 头像读取 TOCTOU、R2 cleanup 无日志/并发残留风险；2026-07-06 已确认 myagents-space-assets 绑定 files.myagents.io，R2_PUBLIC_BASE_URL 配置为 https://files.myagents.io，并用临时对象完成公开直链实测。"
---

# Team Space 登录用户资料设置 PRD

## 执行须知（给空 session 的你）

本 PRD 已把本轮讨论、代码扫描和关键裁决收口成独立上下文。实现时不要回头依赖聊天记录。

动手前必须主动读：

- `AGENTS.md` 或当前会话加载的项目指令，重点是 Space、Overlay、前端设计、文件上传、Rust HTTP 边界。
- `specs/ARCHITECTURE.md`，尤其是「MyAgents Cloud Space」：Space 不是 Sidecar / AI Runtime；云端登录、session、HTTP 请求由 Rust Tauri command 拥有。
- `specs/tech_docs/space_cloud.md`：确认 Space session、cloud API、mock mode、registered agent 与 CLI 的边界。
- `specs/DESIGN.md`：本需求包含 overlay、菜单和身份 UI，必须用现有 token、`OverlayBackdrop`、`useCloseLayer`、字号规范和 i18n 资源。
- 平级云端仓库 `/Users/zhihu/Documents/project/MyAgents_space`：本需求需要同时改 Worker API、D1 migration、R2 存储和 route tests。

关键代码入口：

- Desktop renderer：`src/renderer/api/spaceCloud.ts`、`src/renderer/pages/Space.tsx`、`src/renderer/pages/space/SpaceChrome.tsx`、`src/renderer/pages/space/spaceStore.ts`、`IssuesWorkspace.tsx`、`IssueDetailDrawer.tsx`、`SkillsWorkspace.tsx`。
- Desktop Rust：`src-tauri/src/space_cloud.rs`、`src-tauri/src/lib.rs`。
- Cloud Worker：`MyAgents_space/src/index.ts`、`src/domain/types.ts`、`src/services/storage.ts`、`migrations/`、`test/space-routes.test.ts`。

引用符号名而非行号；行号会随并发修改漂移。

## 1. 背景与产品判断

Team Space 已经有 Google OAuth 登录、官方 Space、Issue、评论、Skill 浏览和上传等基础闭环，但登录用户自己的身份资料还没有成为产品级能力。当前左下角账户入口主要展示 email；用户无法在 Space 内设置昵称和头像，也无法让自己的协作身份自然出现在 Issue / 评论 / Skill 上传人位置。

这不是单纯的前端显示问题。现有系统里 `users.name` / `users.avatar_url` 已经存在，但缺少四段闭环：

1. Google 登录时保留 Google profile picture 作为默认头像。
2. 用户在桌面端编辑昵称、上传本地头像。
3. 云端把自定义资料写入 `users`，并避免后续 Google 重登覆盖。
4. Space 各协作 DTO 返回作者昵称和头像，前端统一展示。

本期北极星：

> 用户在 Team Space 左下角看到的是一个人，而不是一串 email；这个身份资料在 Issue、评论和 Skill 上传人中保持一致，且用户上传头像后走公开 R2 直链，不经过 Worker 转发图片流量。

## 2. 当前技术事实

### 2.1 Desktop 事实

- `src/renderer/api/spaceCloud.ts` 的 `SpaceUser` 已有 `name` / `avatarUrl` 字段。
- `SpaceIssue.creator` / `SpaceIssue.author` 当前只有 `id` / `name`，没有 `avatarUrl`。
- `SpaceIssueComment.author` 当前只有 `id` / `type`，没有用户昵称或头像。
- `SpaceSkill` 当前没有 creator / uploader 字段；`SkillsWorkspace.tsx` 现在用 `skill.slug || 'official'` 充当作者展示，不是产品语义。
- `SpaceChrome.tsx` 左下角账户按钮当前展示 email，菜单顶部显示登录方式和 email，并保留退出登录。
- `Space.tsx` 持有 Space shell 和 tab 编排；`spaceStore.ts` 是 Space 数据快照 owner，适合承接 profile 更新后的 session 和作者缓存更新。
- `src-tauri/src/space_cloud.rs` 是 Space session、OAuth、cloud API、multipart upload 的 owner。renderer 不应直接 fetch 云端。
- `cmd_space_get_session` 当前主要读本地 `~/.myagents/space/session.json` 并 upsert device，没有主动刷新 `/api/me`。
- 现有 Skill zip / Issue attachment 上传命令已经有可复用的绝对路径、symlink、文件大小和 multipart 校验模式。
- Tauri CSP 的 `img-src` 已允许 `https:`，Google / R2 公开头像 URL 可直接渲染。

### 2.2 Cloud 事实

- `MyAgents_space` 的 `users` 表已有 `name` / `avatar_url`。
- Google OAuth 已申请 `openid email profile` scope，`exchangeGoogleCode` 能拿到 `picture`。
- `GET /api/me` 已返回 `serializeUser(user)`，包括 `id` / `email` / `name` / `avatarUrl`。
- `upsertGoogleUser` 当前会更新 `users.name` / `users.avatar_url`，如果直接新增用户自定义资料，会在重新 Google 登录时被覆盖。
- 云端已有 R2 存储 helper `storeR2` / `deleteR2`，但 Issue / Skill 附件下载当前走 Worker 鉴权 route。头像这次明确不走 Worker 代理，需要返回公开 R2 URL。
- Issue list/detail 当前只 join `users.name AS creator_name`。
- Issue comments 当前不 join `users` / `registered_agents`。
- Skills list/detail 当前没有 join 最新 revision 的上传用户。

## 3. 本期范围

### 3.1 要做

1. 左下角 Space 账户入口从 email 改成「头像 + 昵称」。
2. 保留当前账户菜单，在菜单内新增「设置」行。
3. 菜单顶部改为身份卡：第一行「头像 + 昵称」，第二行 email；email 置弱，不可编辑。
4. 点击「设置」打开 profile settings overlay。
5. overlay 支持编辑昵称、点击头像选择本地图片上传、展示只读 email。
6. Google 登录的新用户默认使用 Google profile picture。
7. 用户上传头像后，图片存入 MyAgents Space 的 R2 bucket，并把 `users.avatar_url` 更新为公开 R2 直链。
8. 重新 Google 登录不得覆盖用户自定义昵称，也不得覆盖 R2 自定义头像。
9. Issue 列表作者、Issue 详情作者、Issue 评论作者、Skill 列表上传人、Skill 详情上传人，均在名字左侧展示小圆形头像。
10. Skill 上传人语义使用「最新 revision 上传人」，不是首发创建者。
11. mock Space 支持 profile 设置和头像展示，方便本地 UI 验证。

### 3.2 明确不做

- 不做头像移除。
- 不做头像 URL 手动输入。
- 不做头像裁剪、滤镜、生成头像。
- 不做完整成员资料页。
- 不做多 Space profile 差异化。用户 profile 仍是 account-level，所有 Space 共享。
- 不做 Goals 页面作者改造。当前 Goals 没有登录用户作者展示。
- 不做 Agents / Registered Agent 头像设置。Registered Agent 是 agent/workspace/device 身份，不混入登录用户头像。
- 不把头像图片经 Worker 代理下载。用户上传头像返回公开 R2 直链，客户端直接渲染。

## 4. 核心交互

### 4.1 左下角账户入口

收起状态：

- 展示圆形头像和昵称。
- 昵称优先级：`user.name` trim 后非空，其次 email 前缀，其次完整 email。
- 头像优先级：`user.avatarUrl`，否则用昵称首字母 fallback。
- 仍保留现有展开箭头和菜单行为。
- 如果昵称过长，单行 ellipsis；不要撑开左侧栏。

展开菜单：

- 顶部身份卡：
  - 第一行：圆形头像 + 昵称。
  - 第二行：email，弱色、不可编辑。
- 身份卡下方用当前菜单风格的虚线 / 分割线。
- 分割线下新增「设置」行，建议用 `Settings` icon。
- 「退出登录」保留在设置下方，继续走现有 logout flow。

### 4.2 Profile settings overlay

打开：

- 从账户菜单点击「设置」打开。
- overlay 必须使用 `<OverlayBackdrop>`，不要用裸 `<div onClick>` 遮罩。
- 必须注册 `useCloseLayer(handler, zIndex)`，支持 `Esc` / `Cmd+W` 关闭。
- z-index 与 CSS 层级一致，不能抢过系统级 toast / command palette。

内容：

- 标题：`账户设置` 或 i18n 等价文案。
- 头像区域：
  - 显示当前头像。
  - 点击头像或旁边的上传按钮，选择本地图片。
  - 选中后在 overlay 内预览新头像。
  - 支持 png / jpeg / webp。
  - 文件大小上限建议 5MB。
  - 不接受 svg。头像会公开访问，svg 没必要引入脚本 / 外链风险。
- 昵称输入：
  - 默认填当前昵称。
  - 保存前 trim。
  - 长度建议 1 到 40 个 Unicode 字符。
  - 空值不允许保存；如需恢复默认，可后续单独做「重置昵称」。
- Email：
  - 展示当前登录 email。
  - 置灰，不可编辑。
  - 文案上不要暗示可以改登录邮箱。
- Footer：
  - `取消`
  - `保存`
  - 保存中禁用按钮，展示 loading 状态。

保存行为：

- 如果昵称和头像都未变化，保存按钮禁用或点击后直接关闭均可；推荐禁用。
- 保存成功后：
  - overlay 关闭。
  - 左下角账户入口和菜单身份卡立即更新。
  - 当前页面已加载的 Issue / 评论 / Skill 中属于当前用户的作者摘要应同步 patch，或通过局部 revalidate 更新，避免用户刚保存完仍看到旧头像。
  - toast 成功。
- 保存失败：
  - overlay 不关闭。
  - 保留用户输入。
  - 展示清晰错误，不把 raw reqwest / Worker stack 直接铺给用户。

本地图片预览：

- 不要把任意本地路径直接塞进 `<img src>`。
- 可复用已有安全读取能力生成 data URL / blob preview，或在选择后先上传再用返回的 HTTPS URL 预览。
- 读本地文件时沿用 workspace file / upload 命令里的 symlink 与文件大小校验思路。

## 5. 数据模型与 API

### 5.1 Cloud D1 migration

`users` 当前已有 `name` / `avatar_url`。为了区分 Google 默认资料和用户自定义资料，本期需要新增资料来源字段：

```sql
ALTER TABLE users ADD COLUMN name_source TEXT NOT NULL DEFAULT 'google';
ALTER TABLE users ADD COLUMN avatar_source TEXT NOT NULL DEFAULT 'google';
ALTER TABLE users ADD COLUMN avatar_storage_key TEXT;
```

字段语义：

- `name_source = 'google' | 'user'`
  - `google`：可被下一次 Google profile name 刷新。
  - `user`：用户在 MyAgents Space 设置过昵称，Google 重登不得覆盖。
- `avatar_source = 'google' | 'r2'`
  - `google`：可被下一次 Google profile picture 刷新。
  - `r2`：用户上传过头像，Google 重登不得覆盖。
- `avatar_storage_key`
  - 仅 R2 自定义头像有值，用于后续替换头像时 best-effort 删除旧对象。
  - 本期不做头像移除，因此没有清空 UI；字段仍需要为后续清理能力预留。

### 5.2 Google upsert 规则

`upsertGoogleUser(env, profile)` 必须调整为 preservation-first：

- 新用户：
  - `email = profile.email`
  - `name = profile.name`
  - `avatar_url = profile.picture`
  - `name_source = 'google'`
  - `avatar_source = 'google'`
  - `avatar_storage_key = null`
- 已存在用户：
  - 始终更新 email 的规范化值。
  - 仅当 `name_source !== 'user'` 时，用 `profile.name` 更新 `name`。
  - 仅当 `avatar_source !== 'r2'` 时，用 `profile.picture` 更新 `avatar_url`。
  - 不改 `avatar_storage_key`，除非用户显式上传新头像。

这样既保留 Google 头像作为默认来源，又避免用户自定义资料被重新登录冲掉。

### 5.3 公开 R2 头像 URL

头像上传后的 URL 不经过 Worker 代理。Cloud Worker 需要新增环境配置：

```text
R2_PUBLIC_BASE_URL=https://<public-r2-domain>
```

约束：

- 该 URL 必须对应可公开读取的 R2 bucket 自定义域名或公开访问域名。
- Worker 只负责上传对象、写入 D1、返回公开 URL。
- 客户端渲染 `avatarUrl` 时直接请求该 HTTPS URL。
- 实现要 normalize base URL，避免双斜杠和尾斜杠问题。
- 如果生产环境缺少 `R2_PUBLIC_BASE_URL`，头像上传必须返回可理解的配置错误，不要写入一个不可访问 URL。

建议 R2 key：

```text
avatars/users/<userId>/<sha256>.<ext>
```

上传流程：

1. 校验用户 session。
2. 校验文件类型和大小。
3. 读取 bytes，计算 sha256。
4. 写入 R2 key。
5. 更新 `users.avatar_url`、`avatar_source='r2'`、`avatar_storage_key`、`updated_at`。
6. 如果旧头像也是 R2 对象，DB 更新成功后 best-effort 删除旧 key。
7. 返回最新 `GET /api/me` 等价 envelope。

### 5.4 Cloud profile endpoint

新增一个用于设置面板的 endpoint：

```http
POST /api/me/profile
Content-Type: multipart/form-data

name=<trimmed display name>
avatar=<optional image file>
```

返回：

```ts
type SpaceMeEnvelope = {
  user: {
    id: string
    email: string
    name: string | null
    avatarUrl: string | null
  }
  space: SpaceSummary
  membership: SpaceMembershipSummary
}
```

行为：

- `name` 必填，trim 后 1 到 40 个字符。
- `avatar` 可选；不存在时只更新昵称。
- 有 `avatar` 时按 5.3 写 R2 和 D1。
- 任一校验失败，不更新 profile。
- R2 上传成功但 DB 更新失败时，best-effort 删除新对象。
- 返回 envelope 的原因是桌面端本地 session cache 同时持有 `user` / `space` / `membership`，profile 更新后 Rust 可以直接写回一致的 `session.json`。

### 5.5 Cloud author DTO

新增共享摘要概念，避免每个接口各写一套字段：

```ts
type SpaceUserSummary = {
  id: string
  name: string | null
  avatarUrl: string | null
}

type SpaceActorSummary = {
  id: string
  type: 'user' | 'registered_agent'
  name: string | null
  avatarUrl: string | null
}
```

Issue：

- list/detail 的 `creator` 或 `author` 至少包含 `id` / `name` / `avatarUrl`。
- 当前前端已经有 `creator` / `author` 两个相近字段，落地时优先保持兼容，不做大规模重命名。

Comment：

- user comment：join `users`，返回 `author.type='user'`、`name`、`avatarUrl`。
- registered agent comment：join `registered_agents`，返回 `author.type='registered_agent'`、`name=display_name`、`avatarUrl=null`。
- 前端对 registered agent 用 bot / initial fallback，不显示登录用户头像。

Skill：

- list/detail 新增 `uploader?: SpaceUserSummary`。
- `uploader` 表示最新 `skill_revisions` 的 `created_by_user_id`。
- 不再用 `skill.slug` 当作者展示。
- 上传新 revision 后，返回数据或后续 list/detail refresh 必须反映新的 uploader。

## 6. Desktop Rust 方案

新增 Tauri command：

```ts
cmd_space_update_profile(input: {
  name: string
  avatarFilePath?: string | null
}) -> SpaceSessionPublic
```

职责：

- 读取当前 Space session 和 access token。
- 校验 `name`。
- 如果有 `avatarFilePath`：
  - 必须是绝对路径。
  - 用不跟随 symlink 的 metadata 检查。
  - 拒绝 symlink、目录、非普通文件。
  - 限制扩展名和大小。
  - 以 multipart 发送到 `POST /api/me/profile`。
- 如果没有 `avatarFilePath`，仍以 multipart 只发送 `name`，保持云端 endpoint 单一。
- 解析 cloud 返回的 `user` / `space` / `membership`。
- 写回 `~/.myagents/space/session.json` 的 redacted session cache。
- 返回 `SpaceSessionPublic` 给 renderer。

`cmd_space_get_session` 调整：

- 在有本地 session 时，best-effort 调一次 `GET /api/me` 或等价 helper 刷新 `user` / `space` / `membership`。
- 刷新成功则写回本地 session cache。
- 刷新失败不应直接让用户退出登录；可以返回本地 cache，并在日志中记录 refresh failure。
- token 失效仍按现有认证失效路径处理。

注册：

- 在 `src-tauri/src/lib.rs` command list 注册新 command。
- renderer 只通过 `src/renderer/api/spaceCloud.ts` wrapper 调用，不直接 invoke 字符串散落到 UI。

Mock mode：

- mock session user 带 `name` / `avatarUrl`。
- mock `cmd_space_update_profile` 更新内存或 mock session 文件中的 user。
- mock Issue / comment / skill DTO 带 avatar summary，确保 UI 本地可验。

## 7. Desktop renderer 方案

### 7.1 API types

`src/renderer/api/spaceCloud.ts` 更新：

- `SpaceUser` 保持 `name?: string | null`、`avatarUrl?: string | null`。
- `SpaceIssue.creator` / `author` 增加 `avatarUrl?: string | null`。
- `SpaceIssueComment.author` 增加 `name?: string | null`、`avatarUrl?: string | null`。
- `SpaceSkill` 增加 `uploader?: SpaceUserSummary | null`。
- 新增 `spaceUpdateProfile(input)` wrapper。

### 7.2 Store

`spaceStore.ts` 新增 action：

```ts
updateProfile(input: { name: string; avatarFilePath?: string | null }): Promise<void>
```

行为：

- 调 `spaceUpdateProfile`。
- 更新 store session。
- 当前列表 / detail 中如果作者 id 等于 current user id，patch `name` / `avatarUrl`。
- patch 不完整时触发局部 revalidate，不要整页进入 loading。
- 保存成功后不应导致 Space tab 重新初始化。

### 7.3 UI components

建议新增小组件，避免三处重复：

- `SpaceAvatar`
  - props：`name`、`email?`、`avatarUrl?`、`size`
  - 有 URL 显示图片；图片加载失败 fallback initial。
  - 小尺寸固定，不能随文字 hover 造成布局抖动。
- `SpaceIdentityLine`
  - 头像 + 名字一行，用于菜单、Issue row、Skill row。
- `SpaceProfileSettingsDialog`
  - profile overlay。

具体页面：

- `SpaceChrome.tsx`
  - 左下角账户按钮展示 `SpaceAvatar + displayName`。
  - 菜单顶部身份卡改版。
  - 新增「设置」菜单项。
  - 点击设置时通知 `Space.tsx` 打开 overlay，或在 `SpaceChrome` 内部持有 dialog open state。推荐由 `Space.tsx` 持有，避免 sidebar 组件过重。
- `Space.tsx`
  - 持有 `profileSettingsOpen`。
  - 渲染 `SpaceProfileSettingsDialog`。
  - 将 `onOpenProfileSettings` 传给 `SpaceSidebar`。
- `IssuesWorkspace.tsx`
  - Issue 列表作者名前加头像。
  - 使用 `creator.avatarUrl`。
- `IssueDetailDrawer.tsx`
  - 详情 header 作者名前加头像。
  - 评论列表中每条评论作者名前加头像。
  - registered agent comment 使用 agent fallback，不套当前 user 头像。
- `SkillsWorkspace.tsx`
  - Skill 列表和详情上传人使用 `skill.uploader`。
  - 名字左侧展示小圆形头像。

### 7.4 i18n

`src/renderer/i18n/locales/zh-CN/app.json` 和 `en-US/app.json` 同步新增文案：

- 设置
- 账户设置
- 昵称
- 邮箱
- 更换头像
- 保存
- 保存中
- 头像上传失败
- 昵称不能为空
- 资料已更新
- 上传人

不要只改中文。

## 8. UI 与设计红线

- overlay 遮罩必须用 `OverlayBackdrop`。
- overlay 必须用 `useCloseLayer`。
- 不用原生 `<select>`；本需求没有新增 select。
- 不硬编码颜色，使用 CSS token。
- 字号只用 DESIGN.md / Tailwind theme 的标准档。
- 不做卡片套卡片。设置 overlay 本身可以是 modal panel；内部字段不要再套多层装饰卡。
- 头像尺寸需要固定：
  - sidebar account：建议 24 到 28px。
  - menu identity card：建议 32px。
  - author inline：建议 20 到 24px。
  - settings large avatar：建议 64px。
- 图片加载失败要有 fallback，不能出现破图 icon。
- 文本需要 ellipsis，不能挤压菜单箭头或按钮。

## 9. 安全与隐私

- 用户上传头像是公开协作身份信息。上传后 URL 可被公开访问，这是本期明确产品决策。
- 只允许 png / jpeg / webp，拒绝 svg。
- 限制文件大小，建议 5MB。
- Cloud 不信任客户端 MIME，至少用文件头或 bytes sniff 做基础判断。
- R2 key 不包含原始 email。
- R2 public URL 不带 access token。
- Rust 读取本地图片时不跟随 symlink。
- renderer 不接触 access token；所有 cloud 请求仍走 Rust。

## 10. 验收标准

1. 新 Google 用户登录 Team Space 后，如果 Google 返回 `picture`，左下角账户入口显示 Google 头像和昵称。
2. 左下角账户入口显示「头像 + 昵称」，不再默认显示 email。
3. 点击账户入口后，菜单顶部显示身份卡：头像 + 昵称一行，email 一行；分割线下有「设置」和「退出登录」。
4. 点击「设置」打开 profile settings overlay；overlay 可通过关闭按钮、遮罩、Esc、Cmd+W 关闭。
5. overlay 中 email 只读置灰，不可编辑。
6. 用户可以修改昵称并保存；保存后 sidebar、菜单和当前用户相关作者显示更新。
7. 用户可以点击头像选择本地 png / jpeg / webp 上传；保存后 cloud 返回公开 R2 URL，客户端直接渲染该 URL。
8. 上传头像后重新启动 MyAgents，头像和昵称仍保持。
9. 上传头像后重新 Google 登录，R2 头像不会被 Google `picture` 覆盖。
10. 修改昵称后重新 Google 登录，自定义昵称不会被 Google `name` 覆盖。
11. Issue 列表作者、Issue 详情作者、Issue 评论作者均显示小圆形头像。
12. Skill 列表和详情显示最新 revision 上传人的头像和昵称。
13. Registered Agent 评论不显示当前登录用户头像，而是使用 agent fallback。
14. mock mode 能验证账户设置 overlay 和作者头像展示。
15. 头像图片请求不经过 Worker 附件下载 route。

## 11. 测试计划

Desktop：

- `npm run typecheck`
- `npm run lint`
- 针对 `spaceCloud.ts` 类型和 `spaceStore.updateProfile` 增加单测。
- 针对 `SpaceProfileSettingsDialog` 增加 DOM 测试：初始值、只读 email、选择头像、保存 loading、错误保留输入、关闭层。
- 针对 `SpaceAvatar` 增加 fallback 测试。
- mock mode 手测：sidebar、菜单、overlay、Issue、评论、Skill 上传人。

Rust：

- 新增或扩展 `space_cloud` 相关测试，覆盖 profile command 的文件校验、multipart 构造、session cache 写回。
- 回归现有 OAuth/session/attachment upload 流程。

Cloud Worker：

- `npm run typecheck`
- `npm test`
- route tests 覆盖：
  - 新用户 Google picture 写入 `avatar_url`。
  - 用户自定义昵称后，Google upsert 不覆盖。
  - 用户上传 R2 头像后，Google upsert 不覆盖。
  - `POST /api/me/profile` name-only。
  - `POST /api/me/profile` avatar upload 返回 `R2_PUBLIC_BASE_URL` 下的公开 URL。
  - Issue list/detail 返回 creator avatar。
  - Comments 返回 user author name/avatar 和 registered agent displayName。
  - Skills list/detail 返回最新 revision uploader。

端到端手测：

- 真实 Google 登录一次，确认 Google 头像默认展示。
- 上传头像，打开 devtools/network 或日志确认图片 URL 是 R2 公网域名，不是 Worker attachment route。
- 重启客户端，进入 Space，确认本地 session cache 被刷新且展示一致。
- 创建 Issue、发评论、上传 Skill 新 revision，确认作者头像与昵称位置正确。

## 12. 需要提前确认的部署项

实现本需求不需要新的产品决策，但有一个部署前置：

- `MyAgents_space` production / staging 必须配置公开可访问的 R2 头像域名，并设置 `R2_PUBLIC_BASE_URL`。

如果当前 R2 bucket 还没有公开域名，需要先在 Cloudflare 侧完成 bucket public access 或自定义域名绑定。否则头像上传 endpoint 不应假装成功。

## 13. 附录：本轮关键裁决

- 用户资料权威来源是云端 `users`；本地 `~/.myagents/space/session.json` 只是 redacted session cache。
- 左下角账户入口保留现有菜单，不直接点开设置面板。
- 菜单中新增「设置」，点击后打开 overlay。
- 邮箱只展示，不可修改。
- 默认头像使用 Google profile picture。
- 用户本地上传头像后写入 R2，并替换 Google 头像。
- 自定义头像返回公开 R2 直链，不走 Worker。
- 本期不做头像移除。
- Issue / 评论 / Skill 上传人等作者展示位置都加小圆形头像。
- Skill 上传人按最新 revision uploader 展示。

## 执行台账

### 开发契约（动第一行代码前写完）

- 必赢场景：Google 登录用户在 Team Space 左下角看到「头像 + 昵称」；菜单中可进入账户设置 overlay；昵称可保存，头像可从本地 png/jpeg/webp 上传到公开 R2 URL；email 只读；重启和 Google 重登不覆盖自定义昵称/R2 头像；Issue 列表/详情/评论和 Skill 最新 revision 上传人均显示小圆形头像；mock mode 可本地验证。
- 复用的既有抽象：
  - Desktop Space 边界：`src/renderer/api/spaceCloud.ts` typed wrapper、`src-tauri/src/space_cloud.rs` Tauri command owner、`SpaceSession` / `SpaceSessionPublic` 本地 cache。
  - Rust 上传与安全：`cmd_space_upload_skill` / `cmd_space_upload_issue_attachments` 的绝对路径、`fs::symlink_metadata`、文件大小、multipart 构造；`authorized_multipart_data_request`；`write_private_json(session_path)`。
  - Renderer state：`src/renderer/pages/space/spaceStore.ts` 的 `SpaceActions` 和 patch/revalidate 模式；`Space.tsx` 持有 shell overlay open state；`SpaceChrome.tsx` 已有 account menu + `useCloseLayer`。
  - Renderer UI：`OverlayBackdrop`、`useCloseLayer`、`CustomSelect` 避免原生 select；`IssuesWorkspace` / `IssueDetailDrawer` / `SkillsWorkspace` 现有作者信息区域。
  - Cloud：`serializeUser`、`GET /api/me` envelope、`upsertGoogleUser`、`storeR2/deleteR2`、`safeFilename` / `sha256Hex` / `isUploadFile`、`installSkillZip` 与 `skill_revisions.created_by_user_id`。
  - Tests：MyAgents `spaceStore.test.ts` / Space component i18n tests；MyAgents_space `test/space-routes.test.ts` / Miniflare migrations harness。
- 反向边界：不做头像移除、URL 头像输入、裁剪/生成头像、成员资料页、多 Space profile、Goals 作者改造、Registered Agent 头像设置、Worker 头像代理下载。
- 新概念清单：
  - Cloud `name_source` / `avatar_source` / `avatar_storage_key`：必要，用来区分 Google 默认资料和用户自定义资料，防止 Google 重登覆盖。
  - `SpaceUserSummary` / `SpaceActorSummary`：不是新 owner，只是把已有 user/registered-agent 作者摘要字段结构化，避免 Issue/Comment/Skill DTO 各写一套。
  - `SpaceAvatar` 小组件：UI 复用组件，承载头像 URL/fallback/固定尺寸，不引入新状态 owner。
- 触及的红线：
  - Space renderer 不直连云端、不持有 token，所有 profile API 走 Rust Tauri command。
  - 新 overlay 必须使用 `OverlayBackdrop` + `useCloseLayer`。
  - 本地头像路径读取/上传必须拒绝 symlink，不能用 `Path::exists()` 判断。
  - 前端使用 DESIGN token 和标准字号，不硬编码颜色/px 字号。
  - i18n 中英文同步。
  - R2 公开头像 URL 可被公开访问；不走 Worker 代理流量。
  - 当前 worktree 已有用户改动 `src/renderer/pages/space/issues/IssuesWorkspace.tsx`，后续同文件修改必须保留其现有 diff。

### 行动清单

- [x] Cloud Worker：新增 profile migration/env、Google upsert preservation、`POST /api/me/profile`、公开 R2 URL、Issue/Comment/Skill 作者 DTO、route tests。
- [x] Desktop Rust：新增 `cmd_space_update_profile`、session refresh `/api/me`、本地头像校验、mock mode、command 注册。
- [x] Desktop renderer：更新 API/types/store，新增头像/设置 overlay UI，改账户菜单与 Issue/Comment/Skill 作者展示，补 i18n。
- [x] 自验证：MyAgents_space typecheck/tests；MyAgents typecheck/lint/相关测试；必要的 Rust check；需求符合性逐项核查。
- [x] Cross review、修复问题、提交 git、更新 PRD status/review。

### 待用户决策

无。`MyAgents_space` production 已配置公开 R2 域名 `files.myagents.io`，Worker `R2_PUBLIC_BASE_URL` 已更新为 `https://files.myagents.io`；实现仍会在缺失时 fail closed。

### 进展日志

- 2026-07-05：已重读 PRD、Space 架构文档、设计规范与桌面/云端现状；确认本需求不需要新通信模式，按既有 Space Rust owner + renderer wrapper + Cloud Worker API 实现。
- 2026-07-05：云端完成 profile source migration、公开 R2 avatar upload、Google upsert preservation、Issue/Comment/Skill 作者 DTO；`npm run typecheck` 与 `npm test -- --run test/space-routes.test.ts` 通过。
- 2026-07-05：桌面 Rust 完成 `cmd_space_update_profile`、`cmd_space_get_session` best-effort `/api/me` 刷新、mock profile 更新；`cargo check` 通过。
- 2026-07-05：桌面 renderer 完成 `SpaceAvatar` / profile settings overlay / sidebar account menu / Issue 评论 Skill 作者头像展示，头像预览改走 `useWorkspaceFileService(null)`，overlay 使用 `OverlayBackdrop` + `useCloseLayer`。
- 2026-07-05：cross-review-code 三路审查完成并修复：`nameChanged` 防止头像-only 保存锁死 Google 昵称、Rust no-follow + bounded read 降低本地头像 TOCTOU 风险、R2 旧对象/并发 orphan cleanup 加最终 key 对比与 warning、i18n hardcode 清理、Space Cloud 文档补 profile/R2 部署约束。
- 2026-07-05：验证通过：MyAgents `npm run typecheck`、`npm run lint -- --max-warnings=0`（仅既有 depcruise orphan warning）、`npm run build:web`、`npm run test:classification && npm run test:unit && npm run test:dom`；MyAgents Rust `cargo test space_cloud`；MyAgents_space `npm run typecheck && npm test`。
- 2026-07-05：部署检查：`npx wrangler r2 bucket domain list myagents-space-assets` 显示 no custom domains；`npx wrangler r2 bucket dev-url get myagents-space-assets` 显示 public r2.dev disabled。生产/灰度上传头像前必须先启用公开 R2 域名并配置 `R2_PUBLIC_BASE_URL`。
- 2026-07-06：R2 公开域名更新完成：`files.myagents.io` 已绑定 `myagents-space-assets`。已上传临时对象 `__healthchecks/files-domain-check.txt` 并通过 `https://files.myagents.io/__healthchecks/files-domain-check.txt` 实测 200，随后删除临时对象并确认 404。Worker 配置更新为 `R2_PUBLIC_BASE_URL=https://files.myagents.io`。
