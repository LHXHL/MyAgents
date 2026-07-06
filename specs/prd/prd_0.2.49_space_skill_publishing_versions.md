---
type: prd
status: draft
created: 2026-07-06
updated: 2026-07-06
scope: "Team Space Skill 发布与版本治理：把现有“上传 ZIP”升级为“发布到团队空间”，支持从本机 Skill 发布、本地文件发布、从链接导入发布；发布前自动预检并让用户选择新建或更新；Skill 详情新增历史 tab，owner/admin 可把当前版本指针回滚到旧 revision。不做在线编辑器、私有仓库导入、成员管理、安装量统计或自动安装到本机。"
issue: "产品需求：Team Space Skills 发布、权限与版本历史"
research: ""
review: "pending（实现前需再次核对 MyAgents 与 MyAgents_space 当前代码；重点验证本地 Skill 导入解析复用方案、D1 migration、回滚后再发布的 revision 递增语义、以及软链排除策略）"
---

# Team Space Skill 发布与版本治理 PRD

## 执行须知（给空 session 的你）

本 PRD 已把本轮关于 Team Space Skills 权限、上传范围、版本历史和回滚语义的讨论收口成独立上下文。实现时不要依赖聊天记录。

动手前必须主动读：

- `AGENTS.md` 或当前会话加载的项目指令，重点是 Space、Rust/Tauri 边界、前端 overlay、文件上传、工作区文件 IO 与 symlink 红线。
- `specs/ARCHITECTURE.md`：Space 不是 AI Runtime，也不属于 Session Sidecar；云端 session token 和 Space HTTP mutation 由 Rust Tauri command 拥有。
- `specs/tech_docs/space_cloud.md`：确认 Space session、Skill zip、mock mode、registered agent 和 CLI 的边界。
- `specs/DESIGN.md`：本期包含发布面板、详情 tab、确认弹窗、历史列表和按钮状态，必须复用现有 token、字号、`OverlayBackdrop`、`useCloseLayer` 与 i18n。
- 平级云端仓库 `/Users/zhihu/Documents/project/MyAgents_space`：本期需要同时改 Worker API、D1 migration、R2 存储查询、route tests。

关键代码入口：

- Space renderer：`src/renderer/pages/space/skills/SkillsWorkspace.tsx`、`src/renderer/pages/space/spaceStore.ts`、`src/renderer/api/spaceCloud.ts`、`src/renderer/pages/space/spaceHelpers.ts`。
- Space Rust owner：`src-tauri/src/space_cloud.rs`、`src-tauri/src/space_cloud_mock.rs`、`src-tauri/src/lib.rs`。
- 本地 Skill 导入能力：`src/renderer/components/SkillsCommandsList.tsx`、`src/renderer/components/SkillDialogs.tsx`、`src/server/index.ts` 的 `/api/skill/upload` / `/api/skill/install-from-url` / `/api/skill/import-folder`，以及 `src/server/skills/url-resolver.ts`、`src/server/skills/tarball-fetcher.ts`、`src/server/skills/installer.ts`。
- Cloud Worker：`MyAgents_space/src/index.ts`、`src/services/skillService.ts`、`src/constants.ts`、`migrations/`、`test/space-routes.test.ts`。

引用符号名而非行号；行号会随并发修改漂移。

## 1. 背景与产品定位

当前 Team Space 的 Skills 已经能浏览、安装、上传 ZIP，也已经有 `owner / admin / member` 三种角色。但现有体验本质上仍是“传一个文件”：

- Space 列表页只有一个上传入口。
- Space 上传只支持 `.zip`。
- 更新 Skill 是把新的 zip 作为下一条 revision 上传，但产品上没有历史版本入口。
- 后端保留了 `skill_revisions` 和 `skill_files`，但 UI 只看最新 revision。
- 如果用户上传了同名 Skill，现状会复用已有 Skill 并新增 revision，用户没有明确选择“新建还是更新”。

用户希望这件事升级成团队能力资产管理，而不是云盘式文件上传。核心表达是：

> Skill 发布：1）本机搜索后选择发布 2）本地上传 .zip .skill .md 3）导入。这里的 2 和 3 是要完全对齐我当前客户端本地的导入 skill 支持的能力。

本期要把入口从“上传 Skill”改成“发布到团队空间”。发布前系统自动预检，遇到重名时让用户明确选择新建或更新。Skill 详情页增加“历史”tab，管理员可以看到历史版本并回滚当前指向的版本。

这件事的产品判断：

- Skill 是 Space 级团队资产，不是创建者个人资产。
- `owner/admin` 负责团队 Skill 的发布、更新、删除和回滚。
- `member` 可以查看、安装，但不能发布或覆盖团队 Skill。
- 发布到 Space 不等于安装到本机；本地安装和 Space 发布是两个动作。
- 回滚应该是“把当前指针指回旧版本”，而不是复制旧版本生成一个新版本。

## 2. 当前技术事实

### 2.1 Cloud Worker 现状

`MyAgents_space` 当前已有 Skill 三层数据：

- `skills`
  - `id`
  - `space_id`
  - `name`
  - `slug`
  - `description`
  - `latest_revision`
  - `created_by_user_id`
  - `created_at`
  - `updated_at`
  - `deleted_at`
- `skill_revisions`
  - `skill_id`
  - `revision`
  - `package_hash`
  - `package_storage_key`
  - `created_by_user_id`
  - `created_at`
- `skill_files`
  - 每个 revision 对应一套文件树和 R2 storage key。

`src/services/skillService.ts::installSkillZip()` 当前行为：

- 只接受 zip-like 文件。
- 解包后查找 `SKILL.md`。
- 用 `SKILL.md` 所在目录作为 Skill 根目录。
- 新建或更新都会新增一条 `skill_revisions`。
- R2 key 形如 `skills/<skillId>/revisions/<revision>/package.zip` 和 `skills/<skillId>/revisions/<revision>/files/<path>`。
- 然后把 `skills.latest_revision` 更新为新 revision。

Skill routes 现状：

- `GET /api/spaces/:spaceId/skills`：列出未删除 Skill，按 `skills.updated_at DESC`。
- `POST /api/spaces/:spaceId/skills`：需要 `skill.upload`，创建 Skill 或因为 slug 已存在而复用已有 Skill。
- `GET /api/skills/:id`：读取最新 revision 文件树。
- `GET /api/skills/:id/file-content`：按最新 revision 读取文件内容。
- `GET /api/skills/:id/package.zip`：按最新 revision 下载 zip。
- `POST /api/skills/:id/revisions`：需要 `skill.upload`，给指定 Skill 上传新版。
- `DELETE /api/skills/:id`：需要 `skill.delete`，软删除 Skill。

权限现状：

- `ROLE_PERMISSIONS` 给 `owner` 和 `admin` 相同权限。
- `owner/admin` 均有 `skill.upload` / `skill.delete`。
- `member` 没有 Skill mutation 权限。
- 更新不校验创建者本人。

### 2.2 Desktop Space 现状

Space UI 现状：

- `SkillsWorkspace.tsx` 顶部有 `Upload` 按钮，只有 `admin` 布尔值为真时展示。
- `isSpaceAdmin(session)` 判断 `role === 'owner' || role === 'admin'`。
- Skill 详情 overlay 顶部右侧有更多菜单，管理员可“上传新版”和“删除”。
- 详情页已有 tab：入口文档 tab 和“文件”tab。用户截图中红框位置适合增加“历史”tab。
- `spaceStore.ts::uploadSkillRevision()` 已经能调用 `spaceUploadSkillZip({ filePath, skillId })` 并清掉详情缓存。

Rust 现状：

- `cmd_space_upload_skill` 只接受本地 `.zip`。
- 上传前要求绝对路径、扩展名 `.zip`、不是 symlink、是普通文件、大小不超过 50MB。
- Rust 读取 bytes 后 multipart 上传到 Worker。
- 有 mock Space 上传逻辑，但能力也偏 ZIP 上传。

### 2.3 本地 Skill 导入能力现状

本地 Settings / Workspace Skill 管理已经有更完整的导入能力：

- `/api/skill/upload`
  - 支持 `.zip` / `.skill` / `.md`。
  - `.zip` / `.skill`：解包，查找 `SKILL.md`，按目录结构安装到本地 Skills 目录。
  - `.md`：写成一个 Skill 文件夹里的 `SKILL.md`。
  - 当前本地 `.md` 分支会从 frontmatter `name` 或正文第一个 `# heading` 推导名称；但本期 Space 发布按用户裁决更严格，见下文。
- `/api/skill/install-from-url`
  - 支持 GitHub repo/tree URL、`owner/repo`、直连 zip、`npx skills add ...`。
  - `resolveSkillUrl()` 负责解析输入。
  - `fetchSkillZip()` 负责下载 GitHub/raw zip、处理 redirect、SSRF 基础防护、大小限制、GitHub wrapper root 剥离。
  - `analyseTree()` 负责扫描 `SKILL.md`、识别单 Skill、多 Skill、Claude Plugin marketplace。
  - `buildInstallPayload()` 负责把候选 Skill 根目录转换成可安装文件树。
- `/api/skill/import-folder`
  - 支持本地文件夹导入。
  - 要求文件夹根目录有 `SKILL.md`。
  - 会跳过 hidden file、`__MACOSX` 和 symlink。

本期 Space 发布要求“上传文件”和“导入”对齐当前客户端本地导入 Skill 支持的能力。这里的“对齐”包括来源格式、候选识别、多 Skill 选择和危险工具提示，不等于把导入结果自动安装到本机。

## 3. 本期范围

### 3.1 要做

1. 把 Space Skills 顶部的“上传”入口升级为“发布 Skill”。
2. 发布来源包含三类：
   - 从本机 Skill 发布。
   - 本地上传 `.zip` / `.skill` / `.md`。
   - 从链接导入发布。
3. 从本机发布时搜索本机已有 Skill：
   - 包含全局 Skill。
   - 包含项目 Skill。
   - 项目 Skill 显示工作区名称 tag。
   - 全局 Skill 显示“全局”tag。
   - 重名 Skill 不去重；每一行代表一个真实来源。
   - 排除 symlink Skill，因为当前本地同步会自动创建软链。
4. 本地文件发布支持 `.zip` / `.skill` / `.md`。
5. `.md` 上传按 Skill YAML 协议检测；如果无法识别为有效 Skill，直接 toast 报错“不是有效 Skill”，不做让用户补名字的复杂流程。
6. 从链接导入发布对齐本地导入能力：
   - GitHub repo/tree URL。
   - `owner/repo`。
   - 直连 zip。
   - `npx skills add ...`。
   - 单 Skill 自动预检。
   - 多 Skill 进入候选选择。
   - Claude Plugin marketplace 进入 plugin / skills 选择。
7. 发布前自动预检：
   - 解析名称、描述、文件树、包大小、文件数。
   - 检测危险工具提示。
   - 检测同 Space 内 slug/name 冲突。
8. 冲突时必须让用户明确选择：
   - 发布为新 Skill。
   - 作为已有 Skill 的新版本。
   - 不允许静默更新。
9. 后端引入“当前版本指针”：
   - 安装、预览、下载都使用当前版本。
   - 新发布永远生成历史最大版本号 + 1。
   - 回滚只改变当前版本指针。
10. Skill 详情页新增“历史”tab。
11. 历史 tab 展示版本记录：
   - 版本号，显示为 `v1` / `v2` / `v3`。
   - 更新人头像昵称。
   - 更新时间。
   - 当前版本标记。
   - 回滚按钮。
12. 回滚按钮仅 `owner/admin` 可见，且只对非当前版本展示。
13. 点击回滚必须弹确认框。
14. 回滚后：
   - 当前版本指针指向旧 revision。
   - 详情预览、文件树、安装、下载全部读取旧 revision。
   - 历史中旧 revision 标记为“当前”。
   - 写入审计事件。
15. mock Space 更新同等能力，保证 UI 可本地验证。

### 3.2 明确不做

- 不做在线 Skill 编辑器。
- 不做草稿态。
- 不做 semver 输入；本期只展示 `v1/v2/v3`。
- 不做 changelog / release note 输入。
- 不做私有 GitHub 仓库导入。
- 不做 GitLab / Bitbucket 导入。
- 不做成员管理界面。
- 不做“创建者本人可更新，管理员不可更新”的个人资产模型。
- 不做 member 发布权限。
- 不做安装量、收藏、评分、评论。
- 不做自动安装到本机。发布到 Space 后，本机是否安装仍由用户通过现有安装按钮决定。
- 不做回滚后复制成新版本。本期采用指针回滚。
- 不改变普通本地 Settings 里的 Skill 导入行为，除非为了复用逻辑做纯内部重构。

## 4. 核心交互

### 4.1 Skills 列表入口

列表页顶部按钮从“上传”改成“发布 Skill”。

展示规则：

- 仅 `owner/admin` 可见。
- `member` 不展示发布按钮。
- 点击后打开发布面板。
- 发布面板必须是 overlay 或 drawer，使用 `<OverlayBackdrop>` 和 `useCloseLayer`。
- 不允许裸 `<div onClick>` 遮罩，避免拖拽选中文字后误关。

发布面板第一屏是来源选择：

1. 从本机发布。
2. 上传文件发布。
3. 从链接导入发布。

这三个入口的文案要强调“发布到 Space”，不要写成“安装”。

### 4.2 从本机发布

用户选择“从本机发布”后，进入本机 Skill 选择页。

列表范围：

- 全局 Skill：`~/.myagents/skills/<name>/SKILL.md`。
- 项目 Skill：每个已知项目的 `.claude/skills/<name>/SKILL.md`。
- 不排除重复名字。
- 必须排除 symlink：
  - Skill folder 是 symlink，排除。
  - `SKILL.md` 是 symlink，排除。
  - 关键子路径是 symlink，打包时跳过或 fail closed；推荐预检时报错并提示该 Skill 包含软链，不能发布。

列表卡片：

- Skill 名称。
- 描述。
- 来源 tag：
  - `全局`
  - 项目工作区名称，例如 `MyAgents`
- 路径摘要，弱化显示。
- 如果同名有多个来源，不合并。

选择一个 Skill 后进入预检页。

### 4.3 上传文件发布

用户选择“上传文件发布”后打开本地文件选择器。

支持扩展名：

- `.zip`
- `.skill`
- `.md`

规则：

- `.zip` / `.skill`：按 Skill 包解析，查找 `SKILL.md`。
- `.md`：必须是一个有效 Skill 定义文件。
- `.md` 的有效性按用户裁决执行：必须能按 Skill YAML 协议识别。建议要求 YAML frontmatter 中存在字符串 `name`，最好也存在字符串 `description`。
- 如果 `.md` 无法识别，直接 toast：`不是有效 Skill`。不要弹补名字表单。

上传文件只是来源选择，不应立刻写云端。必须先进入预检页。

### 4.4 从链接导入发布

用户选择“从链接导入发布”后进入输入框。

输入格式对齐当前本地导入：

- `owner/repo`
- `owner/repo@skill-name`
- `https://github.com/owner/repo`
- `https://github.com/owner/repo/tree/<ref>/<sub/path>`
- `https://github.com/owner/repo.git`
- `https://example.com/anything.zip`
- `npx skills add owner/repo`
- `npx -y skills add owner/repo --skill foo`

解析后：

- 单 Skill：直接进入预检。
- 多 Skill：展示候选列表，允许选择一个或多个发布。
- marketplace：展示 plugin 列表和 plugin 内 skills，允许选择一个或多个发布。
- 危险工具提示沿用本地导入逻辑的 `hasDangerousTools`。

导入发布不安装到本机。解析和临时打包可以使用本地 temp staging，但最终只上传到 Space。

### 4.5 自动预检

预检页是发布体验的核心。它要让用户在写云端之前看到“将要发布什么”。

每个候选 Skill 预检展示：

- 名称。
- 描述。
- 来源：
  - 全局 / 项目工作区 / 上传文件 / GitHub / npx。
- 文件树摘要。
- `SKILL.md` 入口文件预览。
- 文件数。
- 包大小。
- package hash。
- 是否包含危险工具。
- 是否与 Space 已有 Skill 冲突。

冲突检测：

- 后端或本地预检需要按最终 slug 检查当前 Space 中是否已有未删除 Skill。
- 如果没有冲突，默认动作是“发布为新 Skill”。
- 如果有冲突，必须展示二选一：
  - 新建一个 Skill：需要用户改名，生成不冲突 slug。
  - 更新已有 Skill：作为该 Skill 的下一版本。

不允许当前实现里的静默行为继续存在。也就是说，不能因为 slug 已存在就自动复用已有 Skill 并新增 revision。

### 4.6 发布成功

发布成功后：

- toast 显示发布结果。
- 刷新 Skills 列表。
- 如果只发布了一个 Skill，自动打开该 Skill 详情。
- 如果批量发布多个 Skill，保留在列表并显示批量结果；不强行打开某一个。
- 新发布或新版本都应在列表顶部出现。

### 4.7 Skill 详情历史 tab

在现有详情页 tab 区域增加“历史”。位置建议：

```text
SKILL.md | 文件 | 历史
```

历史 tab 列表内容：

- `vN`。
- 更新人头像昵称。
- 更新时间。
- 包 hash 短码。
- 当前版本 tag。
- 回滚按钮。

管理员视角：

- `owner/admin` 看到非当前版本的“回滚到此版本”按钮。
- 当前版本不展示回滚按钮，只显示“当前”。

成员视角：

- `member` 能看历史列表。
- 不展示回滚按钮。

### 4.8 回滚确认

点击“回滚到此版本”后弹确认框：

- 标题：`回滚 Skill 版本`
- 内容：说明将把当前版本从 `vCurrent` 指向 `vTarget`，后续安装、预览和下载都会使用 `vTarget`。
- 确认按钮：`回滚`
- 取消按钮：`取消`
- loading 时禁用按钮。

确认后：

- 调用 rollback API。
- 清掉当前 Skill 详情缓存、文件缓存和下载状态。
- 重新拉取 Skill detail 和 history。
- toast 成功。

失败时：

- 不关闭确认框或关闭后 toast 均可；推荐保留并展示错误。
- 不改变本地当前版本显示。

## 5. 权限模型

本期沿用 Space 级团队资产模型：

| 能力 | owner | admin | member |
| --- | --- | --- | --- |
| 查看 Skill 列表 | 是 | 是 | 是 |
| 查看 Skill 详情 | 是 | 是 | 是 |
| 安装 Skill | 是 | 是 | 是 |
| 发布新 Skill | 是 | 是 | 否 |
| 发布新版本 | 是 | 是 | 否 |
| 删除 / 下架 Skill | 是 | 是 | 否 |
| 回滚当前版本 | 是 | 是 | 否 |
| 查看历史 | 是 | 是 | 是 |

不要增加“只有创建者本人能更新”的判断。理由：

- 用户明确在讨论中希望搞清楚是否管理员都能更新。
- 当前实现已经把 Skill 当 Space 级资产。
- 如果只有创建者能更新，创建者离开、休假或换账号后团队 Skill 会变成孤儿资产。

创建者信息仍然有价值，但它是展示和审计字段，不是权限边界。

## 6. 版本模型

### 6.1 现有问题

现有 `skills.latest_revision` 同时承担两个含义：

1. 当前安装、预览、下载应该读哪个 revision。
2. 下一次发布新版应该生成哪个 revision。

这在没有回滚时成立；一旦允许“指针倒回去”，这两个含义会冲突。

例子：

```text
已有 v1, v2, v3, v4, v5
当前是 v5
管理员回滚到 v2
```

如果继续用 `latest_revision + 1` 生成下一版，就会尝试创建 v3，和历史 v3 冲突。

### 6.2 目标模型

拆成两个概念：

- `currentRevision`：当前启用版本。安装、预览、下载都读它。
- `latestRevision`：历史最大版本号。新发布永远用 `latestRevision + 1`。

产品展示：

- 历史列表展示 `v1 / v2 / v3`。
- 当前启用版本显示“当前”。
- 不展示 semver。

数据建议：

```sql
ALTER TABLE skills ADD COLUMN current_revision INTEGER;
```

迁移后：

- `current_revision` backfill 为现有 `latest_revision`。
- `latest_revision` 保持历史最大版本号语义。
- 新建 Skill：`latest_revision = 1`，`current_revision = 1`。
- 发布新版：`newRevision = max(skill_revisions.revision) + 1`；写入 `skill_revisions`；更新 `skills.latest_revision = newRevision`、`skills.current_revision = newRevision`。
- 回滚：只更新 `skills.current_revision = targetRevision`，不要新增 `skill_revisions`。

D1 迁移可以选择重建表而非简单 `ALTER`，以确保 `current_revision` 最终非空；MyAgents_space 仍处于开发中，按仓库现有 migration 习惯处理即可。

### 6.3 回滚语义

回滚是指针操作：

```text
currentRevision: v5 -> v2
latestRevision:  v5 不变
```

回滚后：

- `GET /api/skills/:id` 返回 current revision 的文件树。
- `GET /api/skills/:id/file-content` 读取 current revision。
- `GET /api/skills/:id/package.zip` 下载 current revision。
- `install` 安装 current revision。
- 历史 tab 中 v2 显示为“当前”。
- v5 仍保留在历史里，可以再次回滚到 v5。

之后再发布新版：

```text
已有 v1, v2, v3, v4, v5
当前 v2
发布新版 -> v6
currentRevision = v6
latestRevision = v6
```

### 6.4 审计

因为回滚不新增 `skill_revisions`，必须写事件审计。

新增 `space_events` 类型：

- `skill.rolled_back`

payload 建议：

```json
{
  "fromRevision": 5,
  "toRevision": 2
}
```

已有发布事件继续使用：

- `skill.created`
- `skill.updated`
- `skill.deleted`

历史 tab 本期主要展示 revision 列表，不要求展示 rollback event 流。但后端必须有 rollback event，方便未来审计页或管理员活动流使用。

## 7. 后端 API 设计

### 7.1 Skill summary

Skill summary 需要返回当前版本和历史最大版本：

```ts
type SpaceSkill = {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  currentRevision: number;
  latestRevision: number;
  uploader?: {
    id: string;
    name?: string | null;
    avatarUrl?: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
};
```

`uploader` 语义调整为“当前版本上传人”，不是历史最大版本上传人。这样回滚到 v2 后，详情页顶部的人和当前文件内容一致。

如果未来要展示“最后操作人”，另加字段，不要复用 `uploader`。

### 7.2 Skill detail

`GET /api/skills/:id` 返回 current revision：

```ts
type SpaceSkillDetail = {
  skill: SpaceSkill;
  revision: SkillRevision;
  files: SpaceSkillFile[];
};
```

查询必须 join `skills.current_revision`，不要继续 `ORDER BY revision DESC LIMIT 1`。

### 7.3 Skill history

新增：

```http
GET /api/skills/:id/revisions
```

返回：

```ts
type SpaceSkillRevisionHistory = {
  skill: {
    id: string;
    currentRevision: number;
    latestRevision: number;
  };
  items: Array<{
    id: string;
    revision: number;
    packageHash: string;
    packageStorageKey?: string;
    createdAt: string;
    uploader: {
      id: string;
      name?: string | null;
      avatarUrl?: string | null;
    };
    isCurrent: boolean;
  }>;
};
```

排序：

- 默认 `revision DESC`。

权限：

- 任意 Space member 可读。

### 7.4 发布新 Skill

保留并收紧：

```http
POST /api/spaces/:spaceId/skills
```

变化：

- 仍需要 `skill.upload`。
- 不再静默复用同 slug 的 Skill。
- 如果 slug 冲突且请求没有明确指定“更新已有 Skill”，返回 409，并带冲突 Skill 摘要。
- 新建成功时 `currentRevision = latestRevision = 1`。

建议 payload 保持 multipart，但增加显式字段：

```text
file=<canonical zip>
name=<name from preflight>
description=<description from preflight>
sourceType=<local|upload|import>
sourceLabel=<optional display label>
conflictMode=create
```

第一期可不持久化 `sourceType/sourceLabel`，但前后端 payload 要留扩展空间。

### 7.5 发布新版本

保留：

```http
POST /api/skills/:id/revisions
```

变化：

- 仍需要 `skill.upload`。
- `newRevision` 必须用历史最大值 + 1，不是 `skills.current_revision + 1`。
- 发布成功后：
  - `skills.latest_revision = newRevision`
  - `skills.current_revision = newRevision`
  - `skills.name/description` 更新为新包解析出的值，或沿用预检提交值。
  - `skills.updated_at = now`
- 返回 updated summary。

### 7.6 回滚

新增：

```http
POST /api/skills/:id/rollback
Content-Type: application/json

{
  "revision": 2
}
```

规则：

- 需要 `skill.upload` 或新增 `skill.rollback`。本期建议复用 `skill.upload`，因为权限边界仍是 owner/admin。
- 校验 Skill 属于当前 Space 且未删除。
- 校验 target revision 存在。
- 如果 target revision 已经是 current revision，返回成功或 400 均可；推荐幂等成功。
- 更新 `skills.current_revision`。
- 更新 `skills.updated_at`，让列表排序体现最近发生过管理动作。
- 写 `space_events`：`skill.rolled_back`。
- 返回最新 Skill summary。

## 8. 桌面端发布准备架构

### 8.1 基本原则

Space 云端 mutation 仍归 Rust/Worker：

```text
Renderer UI
-> Tauri command / Rust Space owner
-> MyAgents_space Worker
-> D1 + R2
```

不要让 renderer 持有 Space session token。不要让 Worker 去复刻本地导入器的全部逻辑。

但“来源解析、GitHub/npx 输入兼容、多 Skill 识别、危险工具检测”已经在本地 Skill 导入能力中成熟存在。为了满足“完全对齐当前客户端本地导入 Skill 支持的能力”，本期应复用这套本地解析逻辑，而不是在 Cloud Worker 里再写一套。

推荐实现方式：

1. 把 `src/server/skills/url-resolver.ts`、`tarball-fetcher.ts`、`installer.ts` 中的解析和候选生成能力封装为“发布准备” helper。
2. 新增本地 publish preparation endpoint 或本地 helper，只做以下事情：
   - 解析 source。
   - 生成候选 Skill。
   - 预检。
   - 生成 canonical zip 到临时目录。
   - 返回 temp zip path 和候选元数据。
3. Rust `space_cloud.rs` 继续负责读取 temp zip、做本地文件安全校验、multipart 上传到 Worker。
4. 本地 helper 不接触 Space session token，不直接请求 MyAgents_space。

这样可以同时满足两点：

- Space 云端状态仍由 Rust/Worker owner 管。
- 上传/导入来源能力与当前本地导入器保持一致。

### 8.2 发布准备输出

无论来源是本机、上传文件还是 URL，进入 Worker 前都应归一为：

```ts
type PreparedSpaceSkillPackage = {
  tempZipPath: string;
  name: string;
  description?: string | null;
  slug: string;
  files: Array<{
    path: string;
    sizeBytes: number;
    mimeType?: string | null;
  }>;
  packageHash: string;
  packageSizeBytes: number;
  hasDangerousTools: boolean;
  source: {
    type: "local" | "upload" | "import";
    label: string;
    workspaceName?: string;
    originalPath?: string;
    sourceUrl?: string;
    effectiveRef?: string;
  };
};
```

canonical zip 要求：

- zip root 即 Skill root。
- root 下必须有 `SKILL.md`。
- 不包含父目录 wrapper。
- 不包含 symlink。
- 不包含 `__MACOSX`。
- 不包含路径逃逸。
- 文件大小和总大小在本地预检阶段就要提前发现。

### 8.3 本机 Skill 列表

新增本机可发布 Skill 列表能力。

候选结构：

```ts
type LocalPublishableSkill = {
  id: string;
  name: string;
  description?: string | null;
  scope: "global" | "project";
  workspaceName?: string;
  workspacePath?: string;
  skillRootPath: string;
  folderName: string;
};
```

扫描约束：

- 必须用不跟随 symlink 的 API 检查 Skill folder 和 `SKILL.md`。
- symlink Skill 不进入列表。
- 重名不去重。
- project tag 使用工作区展示名；没有展示名时用目录 basename。

### 8.4 `.md` 发布的严格判定

本地 `/api/skill/upload` 当前 `.md` 分支允许从第一个 `# heading` 推导 name。Space 发布本期不沿用这个宽松 fallback。

本期 Space `.md` 上传规则：

- 必须能解析 frontmatter。
- frontmatter 必须包含字符串 `name`。
- 建议要求 `description` 也是字符串；如果不强制，也要在预检中明确显示为空。
- 不满足时直接 toast：`不是有效 Skill`。

这是用户明确裁决：不做补名字表单，不做复杂恢复。

## 9. 前端状态与 UI 改造

### 9.1 API types

`src/renderer/api/spaceCloud.ts` 需要扩展：

- `SpaceSkill.currentRevision`
- `SpaceSkill.latestRevision`
- `SpaceSkillRevisionHistory`
- `spaceListSkillRevisions(skillId)`
- `spaceRollbackSkillRevision(skillId, revision)`
- 发布准备 / 发布提交相关 wrapper。

现有 `latestRevision` 字段保留，但语义从“当前最新”变成“历史最大”。

### 9.2 Store

`spaceStore.ts` 需要新增：

- `skillRevisionHistories`
- `refreshSkillRevisions(skillId, options)`
- `rollbackSkillRevision(skillId, revision)`
- `previewSkillPublishSource(...)`
- `publishPreparedSkill(...)`

回滚成功后必须清理：

- 当前 Skill detail cache。
- 当前 Skill file cache。
- 当前 Skill history cache。
- Skills list 对应 item。

### 9.3 SkillsWorkspace

改造点：

- 顶部按钮文案改为“发布 Skill”。
- 新增发布 overlay。
- 详情 tab 增加“历史”。
- 历史 tab 只在打开后 lazy load。
- 回滚按钮仅 admin 可见。
- 回滚确认复用 `ConfirmDialog`。

不要把发布 overlay 做成嵌套卡片堆叠。它是一个工作流面板：来源选择、预检、发布确认三步即可。

### 9.4 i18n

新增中英文文案至少覆盖：

- 发布 Skill。
- 从本机发布。
- 上传文件发布。
- 从链接导入发布。
- 不是有效 Skill。
- 预检。
- 发布为新 Skill。
- 更新已有 Skill。
- 历史。
- 当前版本。
- 回滚到此版本。
- 回滚 Skill 版本。
- 回滚成功。

## 10. Cloud Worker 与 D1 改造

### 10.1 Migration

新增或重建 `skills.current_revision`。

Backfill：

```sql
UPDATE skills SET current_revision = latest_revision WHERE current_revision IS NULL;
```

如果采用 table rebuild，最终约束应保证：

- `latest_revision >= 1` for active skills。
- `current_revision >= 1` for active skills。
- `(skill_id, revision)` 仍唯一。

### 10.2 skillService

`installSkillZip()` 需要拆清语义：

- 新建 Skill：
  - `latest_revision = 1`
  - `current_revision = 1`
- 更新 Skill：
  - `newRevision = SELECT MAX(revision) FROM skill_revisions WHERE skill_id = ?` + 1
  - 不使用 `skills.current_revision + 1`
  - 不依赖回滚后的 current pointer

同时调整 slug conflict：

- 创建 endpoint 不应在 slug 已存在时静默复用。
- 更新 endpoint 必须显式传 skill id。

### 10.3 Queries

这些 query 必须从 latest 改成 current：

- `loadSkillSummary`
- `GET /api/skills/:id`
- `GET /api/skills/:id/file-content`
- `GET /api/skills/:id/package.zip`

这些 query 需要使用 max/latest：

- 发布新版本。
- history 列表。

### 10.4 Tests

Cloud route tests 必须覆盖：

- owner 可以发布新 Skill。
- admin 可以发布新版本。
- member 发布返回 403。
- 创建同 slug 不再静默更新，返回冲突。
- 显式更新已有 Skill 生成下一 revision。
- 回滚到旧 revision 后，detail/file-content/package.zip 都读旧 revision。
- 回滚后再发布新版，版本号使用历史最大 + 1。
- history 返回上传人昵称头像。
- member 可以看 history 但不能 rollback。
- rollback 写 `skill.rolled_back` event。

## 11. Mock Space

`src-tauri/src/space_cloud_mock.rs` 需要跟进：

- Mock Skill 增加 `currentRevision` 和 revision history。
- 上传新版使用 max + 1。
- rollback 改 current pointer。
- Skill detail/file/package mock 按 current pointer 返回。
- 历史 tab 在 mock mode 可用。

否则前端开发会只能连真实 Worker 验证，反馈周期太长。

## 12. 验收标准

### 12.1 发布来源

1. owner/admin 进入 Space Skills，看到“发布 Skill”。
2. member 进入 Space Skills，看不到发布入口。
3. 从本机发布能看到全局 Skill 和项目 Skill。
4. 项目 Skill 显示工作区名称 tag。
5. 同名 Skill 如果来自不同来源，列表不去重。
6. symlink Skill 不出现在可发布列表。
7. 上传 `.zip` / `.skill` / `.md` 均可进入预检。
8. 无有效 Skill YAML 的 `.md` 直接 toast “不是有效 Skill”。
9. GitHub URL / `owner/repo` / `npx skills add ...` 能进入导入预检。
10. 多 Skill 来源能选择候选。

### 12.2 预检与发布

1. 预检页显示名称、描述、来源、文件树、包大小、文件数、hash。
2. 发现 Space 已有同 slug Skill 时，用户必须选择新建或更新。
3. 不会静默把同名上传变成新版。
4. 发布到 Space 后不会自动安装到本机。
5. 单个发布成功后自动打开 Skill 详情。

### 12.3 历史与回滚

1. Skill 详情有 `历史` tab。
2. 历史 tab 显示 v1/v2/v3、更新人、更新时间。
3. 当前版本有“当前”标记。
4. owner/admin 可看到非当前版本的回滚按钮。
5. member 看不到回滚按钮。
6. 点击回滚有确认弹窗。
7. 回滚到 v2 后，SKILL.md 预览、文件列表、安装下载都使用 v2。
8. 回滚到 v2 后再发布新版，生成 vN+1，而不是覆盖 v3 或报唯一冲突。
9. 回滚事件进入 `space_events`。

## 13. 关键设计决策汇总

### D1：Skill 是 Space 级团队资产，不是创建者个人资产

定案：owner/admin 可以发布、更新、删除、回滚任意 Space Skill；member 只能查看和安装。

为什么：团队 Skill 要能被管理员维护。如果只有创建者能更新，创建者离开或换账号会让资产变成孤儿。现有后端权限也已经按 Space 管理权限实现。

### D2：发布到 Space 不自动安装到本机

定案：链接导入发布只把 Skill 发布到 Space，不自动写入本机全局或项目 Skill 目录。

为什么：本地安装和团队发布是两个动作。自动安装会让用户难以理解“我刚刚是在分享给团队，还是改了本机环境”。

### D3：上传/导入来源能力对齐本地导入器，但云端 mutation 仍归 Rust/Worker

定案：复用现有本地 Skill 导入解析能力生成 canonical package；Worker 只负责权限、存储、版本和回滚。

为什么：本地已经有 GitHub/npx/multi-skill/marketplace 解析能力。在 Worker 再实现一套会漂移。Space session token 仍不能交给 Node helper；Node helper只做本地准备，不做云端写入。

### D4：回滚采用指针回滚，不复制生成新版本

定案：回滚只改 `currentRevision`，不新增 `skill_revisions`。

为什么：用户认为这更方便，也更符合“回到旧版本”的直觉。为了避免版本号冲突，必须把 `currentRevision` 和 `latestRevision` 拆开。

### D5：`.md` 上传严格按 Skill YAML 协议判定

定案：Space `.md` 发布不做补名字表单，不用正文 heading 兜底。解析不到有效 Skill 就 toast 报错。

为什么：用户明确要求“不做复杂”。团队空间发布是公共资产写入，宁可严格一点，也不要把普通 Markdown 误发成 Skill。

### D6：本机 Skill 列表不去重，但排除软链

定案：全局和项目 Skill 都列出，重复名字保留；symlink 来源排除。

为什么：重复名字可能代表不同工作区里的真实 Skill，用户需要看到来源。软链是当前同步机制自动创建的副本，不排除会制造重复且容易误发布同一份资产。

## 14. 开放问题

本轮已收敛主要产品决策。实现前仍需技术验证：

- 本地 publish preparation 采用 Global Sidecar endpoint、Rust command 内部调用 Node helper，还是抽成独立 bundled Node helper。原则是不要复制导入解析逻辑到 Worker，也不要让 Node helper 持有 Space token。
- D1 migration 是简单 `ALTER + backfill` 还是重建 `skills` 表以获得更强约束。
- `.md` 有效 Skill 的严格条件最终定为“必须有 `name`”还是“必须有 `name` 和 `description`”。产品方向是严格，不做补全；实现可按 Agent Skills spec 当前要求决定。

## 15. 关联文档

- `specs/ARCHITECTURE.md`
- `specs/tech_docs/space_cloud.md`
- `specs/DESIGN.md`
- `specs/prd/prd_0.2.49_team_space_profile_settings.md`
- `/Users/zhihu/Documents/project/MyAgents_space/migrations/0001_initial.sql`
- `/Users/zhihu/Documents/project/MyAgents_space/src/services/skillService.ts`
- `src/server/skills/url-resolver.ts`
- `src/server/skills/tarball-fetcher.ts`
- `src/server/skills/installer.ts`

## 执行台账

### 开发契约（动第一行代码前写完）

- 必赢场景：owner/admin 在 Space Skills 点击“发布 Skill”，可以从本机 Skill、本地 `.zip/.skill/.md`、GitHub/npx 链接进入预检；同名冲突必须明确选择新建或更新；发布后详情可在“历史”tab 看到 v1/v2 等版本；管理员可确认回滚到旧版本；回滚后预览、文件、安装包都读取旧版本；再发布新版时版本号按历史最大值继续递增。member 可查看和安装，但看不到发布/回滚能力。
- 复用的既有抽象：Space 云端请求继续由 `src-tauri/src/space_cloud.rs` owning，renderer 只走 `src/renderer/api/spaceCloud.ts` wrapper 和 `spaceStore.ts`；Cloud Worker 继续在 `MyAgents_space/src/index.ts` / `src/services/skillService.ts` 管 D1/R2；本地导入解析复用 `src/server/skills/url-resolver.ts`、`src/server/skills/tarball-fetcher.ts`、`src/server/skills/installer.ts`，不要在 Worker 另写一套 GitHub/npx 解析；overlay 复用 `OverlayBackdrop`、`useCloseLayer`、`ConfirmDialog`；作者展示复用 `SpaceIdentityLine`。
- 反向边界：不做在线编辑器、草稿、semver 输入、私有仓库、GitLab/Bitbucket、成员管理、安装量/收藏/评分、发布后自动安装本机、回滚复制成新版本、普通 Settings Skill 导入行为改造。
- 新概念清单：`currentRevision`（必要：把当前启用版本与历史最大版本拆开，支持指针回滚后再发布）；Space Skill 发布准备包（必要：把三种来源归一成 canonical zip，再交给 Rust/Worker 上传）；Skill revision history cache（必要：详情历史 tab lazy load 与回滚后缓存失效）。
- 触及的红线：Space 请求不能绕过 Rust 能力边界，renderer 不持有 session token；工作区/本地文件读取必须校验 symlink 和路径边界；新增 overlay 必须用 `OverlayBackdrop` + `useCloseLayer`；前端颜色/字号走 DESIGN token；新增 Rust 阻塞文件操作不能卡 Tauri 主线程；新增 Node fetch 必须有 timeout/SSRF 防护或复用已有 `fetchSkillZip()`；不要把 Worker 变成本地导入器的第二实现。

### 行动清单

- [x] Phase 1：MyAgents_space 后端数据模型与 API：`current_revision` migration、current/latest query 拆分、history、rollback、slug 冲突不静默更新、route tests。
- [x] Phase 2：Desktop Rust/mock/API/store：Skill history/rollback wrapper、`.zip/.skill/.md` 发布上传、mock currentRevision/history/rollback。
- [x] Phase 3：发布准备能力：本机 Skill 扫描（全局+项目、排除 symlink）、本地文件与链接导入预检、canonical zip、冲突检测。
- [x] Phase 4：Space Skills UI：发布 overlay、预检/新建更新选择、历史 tab、回滚确认、i18n 与 UI tests。
- [x] Phase 5：验证、PRD 符合性检查、cross-review、修复、提交。

### 待用户决策

无。当前产品岔路已在 PRD 中收敛。

### 进展日志

- 2026-07-06：进入 `/start-dev`；已重读 PRD、`specs/ARCHITECTURE.md`、`specs/tech_docs/space_cloud.md`、`specs/DESIGN.md` 和 start-dev 规范；确认先做 Cloud Worker 版本指针/history/rollback，再接桌面端与 UI。
- 2026-07-06：完成 MyAgents_space Worker：新增 `current_revision` migration；详情/文件/下载改读 current pointer；新增 revision history 与 rollback API；新建同 slug 不再静默更新；回滚只更新 pointer；软删除后同 slug 重新发布会恢复原 Skill 并新增 revision；R2 key 使用 `revisionId` 隔离并发失败 cleanup。
- 2026-07-06：完成 Desktop：Rust Space owner 支持 `.zip/.skill/.md`/目录 packaging、URL 导入发布准备、临时包 cleanup、本机全局/项目 Skill 扫描并排除 symlink；renderer Space Skills 增加发布 overlay、URL 候选选择、新建/更新预检、历史 tab、admin rollback 确认。
- 2026-07-06：cross-review-code 三路审查完成并修复：URL 发布入口从 renderer 直连 global sidecar 改为 Rust Space command owning；项目 Skill 扫描改走 `validate_workspace_root`；`.md` 与本机 `SKILL.md` 改为 no-follow bounded read；目录发布文件读取修复 symlink TOCTOU；软删除 slug、并发 revision R2 cleanup、history tab stale refresh 均已修复。
- 2026-07-06：验证通过：MyAgents `npm run typecheck`、`npm run lint`（仅既有 `src/renderer/constants/chatSuggestions.ts` depcruise orphan warning）、`npx vitest run --project unit src/renderer/pages/space/spaceStore.test.ts`、`npx vitest run --project dom src/renderer/pages/space/goals/GoalsWorkspace.test.tsx`；MyAgents Rust `cargo fmt --check`、`cargo check`；MyAgents_space `npm run typecheck`、`npm test -- test/space-routes.test.ts`。
