---
type: prd
status: implemented
created: 2026-07-15
updated: 2026-07-16
scope: "MyAgents 0.3.1 Team Space 前端体验收口：Issue 列表把详细状态选择器隐藏但保留实现，替换为默认『未完成』的『全部 / 未完成』分段切换；统一所有 Goal 路径为灰色祖先 + 黑色常规字重末级；为 Issue 正文、评论内容和 Goal context 建立克制的叙事内容内缩。『全部』继续使用显式 state=all；产品实现限于 Desktop Renderer，不改生产 Rust 代理、Cloud API、查询协议或数据模型。"
issue: "用户基于 Team Space 实际界面提出 Issue 一级状态入口过重、Goal 路径层级样式不一致、正文缺少从属缩进；首版上线体验后进一步裁决：保留『全部 / 未完成』切换，但默认落在更聚焦待处理事项的『未完成』。"
research: "specs/ARCHITECTURE.md; specs/DESIGN.md; specs/tech_docs/space_cloud.md; specs/tech_docs/react_stability_rules.md; specs/prd/prd_0.2.50_team_space_pro_operations_and_ux.md; specs/prd/prd_0.3.1_space_cli_goal_discovery_and_issue_update.md; src/renderer/pages/space/Space.tsx; src/renderer/pages/space/spaceHelpers.ts; src/renderer/pages/space/spaceStore.ts; src/renderer/pages/space/spaceUi.ts; src/renderer/pages/space/GoalPathSelectLabel.tsx; src/renderer/pages/space/issues/; src/renderer/pages/space/goals/GoalsWorkspace.tsx; src/renderer/pages/space/agents/AgentsWorkspace.tsx; ../MyAgents_space/src/index.ts::buildGoalPathLabels"
review: "2026-07-16 默认『未完成』批次经 requirements / adversarial / architecture 三视角 repair cross-review 无剩余 blocker；adversarial 初审发现并推动修复 logout 远端 await 竞态，同 reviewer follow-up PASS。真实 WebView 视觉 smoke 因无可用 in-app Browser 保留为人工验收项。"
---

# Team Space Issue 筛选与内容层级优化 PRD（0.3.1）

> **执行须知（给零上下文 session）**：需求已经收敛，本文是完整实现合同，不需要回看原始会话或截图。
>
> 1. 动代码前完整阅读仓库根指令、`specs/ARCHITECTURE.md`、`specs/DESIGN.md`、`specs/tech_docs/space_cloud.md` 与 `specs/tech_docs/react_stability_rules.md`。
> 2. 产品实现只改 Desktop Renderer；允许 `src-tauri/src/space_cloud_mock.rs` 作为 dev/test 契约替身与既有 Cloud 行为对齐。生产请求继续经 `spaceCloud.ts → Tauri/Rust → Cloud`，不得修改生产 Rust 代理、Cloud 查询语义或新增 WebView 直连/后端筛选概念。
> 3. 本文引用符号名而非行号；行号漂移时用 `rg` 搜索现状。优先复用既有 `selectedStatus`、`ACTIVE_ISSUE_STATE_FILTER`、`CustomSelect`、CSS token 与 Space UI 常量。
> 4. 工作区可能同时有其他未提交修改。只提交本 PRD 所列文件，不得覆盖、格式化或夹带无关 diff。

---

## 1. 一页结论

本期修正三个相互关联的视觉与交互错位：

1. Issue 工具栏不再默认暴露详细状态下拉。原能力保留并继续参与编译，但入口由文件内静态开关关闭；默认渲染等宽的「全部 / 未完成」分段按钮，初始值为「未完成」。
2. 所有可选择 Goal 的位置复用同一个路径标签渲染器。无论 Cloud 返回 `父 / 子` 还是深层压缩格式 `../父/子`，都显示为“祖先前缀灰色、末级黑色、末级常规字重”。
3. 只读叙事正文相对所属标题或身份头形成轻微内缩：常规宽度左右各 12px，窄宽度左右各 8px。首批覆盖 Issue 正文、评论正文与评论附件、Goal context；不把这个规则泛化到列表、表单或独立卡片。

本期不新增服务端状态、不改变 Issue 状态定义、不改 Goal label 协议，也不全面重做详情页。

## 2. 背景与用户意志

### 2.1 Issue 筛选暴露了错误的一级复杂度

现有工具栏第一个控件是详细状态 `CustomSelect`，默认值为 `open,todo,doing`。这带来两个问题：

- 用户首次进入时看不到已完成 Issue，却没有明显意识到列表已被过滤；
- 一级入口把 open/todo/doing/done/closed 等实现态直接暴露给用户，高频使用真正需要的只是“完整集合”和“仍需处理”。

用户明确要求隐藏详细选择器，但保留功能代码并说明暂不启用；在同一位置换成「全部 / 未完成」左右切换。首版默认「全部」经实机体验后，用户进一步裁决默认改为「未完成」，让列表优先聚焦仍需处理的事项；「全部」仍需一键可达且必须真正包含已完成内容。

### 2.2 Goal 路径的层级语法不统一

当前 `GoalPathSelectLabel` 只按带空格的 `" / "` 拆分路径，并把末级设为 `font-semibold text-current`：

- `MyAgents社区 / MyAgents BUGFIX` 会得到灰色父级 + 加粗末级；
- Cloud 对三层及以上 Goal 返回 `../MyAgents BUGFIX/Windows 系统兼容性优化`，现组件无法解析，整行退化成黑色；
- Issue 详情任务卡的 Goal picker 又直接渲染纯文本，没有复用共享组件。

用户要的是单一、克制的视觉语法：前面的路径只负责提供上下文，所以灰色；最后一节是当前选择对象，所以黑色；颜色已足以区分层级，不再叠加粗体。

### 2.3 正文与标题同基线，削弱从属关系

Issue 标题与正文、评论身份头与评论正文、Goal 标题与 context 当前完全齐边。视觉上它们更像相邻的同级块，而不是“内容属于上方主题/作者”。

这里需要的是小幅的内容层级修正，而不是给所有容器统一加 padding。内缩只属于只读叙事内容，并相对它自己的标题/身份头建立层级。

## 3. 已验证的当前技术事实

### 3.1 Issue 查询已经支持显式全部语义

- `Space.tsx` 以 `selectedStatus` 驱动 Issue query，并把它传给 `IssuesWorkspace`。
- `ACTIVE_ISSUE_STATE_FILTER` 已定义为 `open,todo,doing`。
- Cloud 的既有兼容契约把缺少/空 `state` 解释为 `open,todo,doing`，把显式 `state=all` 解释为全部五个非归档状态。
- `spaceStore.ts::normalizeIssueQueryParams` 会保留非空的 `all`，`spaceCloud.ts::spaceListIssues` 会把它写入 query string。
- 因此「全部」必须映射显式 `ALL_ISSUE_STATE_FILTER = "all"`；不能用空字符串或省略参数表达，否则会退回 Cloud 的默认未完成语义。「未完成」继续映射 `ACTIVE_ISSUE_STATE_FILTER`。

### 3.2 详细状态选择器可以保留为 dormant UI

- `IssuesWorkspace.tsx::statusFilterOptions` 已基于 `ISSUE_STATUSES` 和 `issueStatusLabel` 构造全部细粒度选项。
- `selectedStatus` / `onStatusChange` 是现成受控接口。
- 通过文件内、带解释的静态常量控制“详细选择器 vs 分段按钮”即可保留实现并继续类型检查，无需运行时配置、feature flag 系统或注释掉一大段 JSX。

### 3.3 Cloud 有两种权威 Goal label 格式

`../MyAgents_space/src/index.ts::buildGoalPathLabels` 当前行为：

- 根目标：`title`
- 两层：`父 / 子`
- 三层及以上：`../父/子`（只保留最后两层）

Desktop 不应改变或复制 Cloud 的路径构造，只需让共享 label renderer 同时理解这两种既有展示格式。

### 3.4 Goal label 已有共享入口，但覆盖不完整

`GoalPathSelectLabel` 已用于：

- Space Issue 列表的 Goal 筛选；
- Create Issue dialog；
- Registered Agent 登记/编辑相关 Goal picker。

`IssueTaskCard` 的当前 Goal trigger 与选项仍是纯文本，应纳入同一共享渲染器。组件名称也不应继续绑定 Select 场景，应收敛为 `GoalPathLabel`。

### 3.5 正文没有统一语义 inset

- `IssueDetailDrawer.tsx::IssueMarkdown` 负责 Issue 正文与评论 Markdown。
- 评论附件与正文属于同一条评论内容，但当前附件独立贴齐身份头基线。
- `GoalsWorkspace.tsx` 的 Goal `context` 紧贴 Goal 标题基线。
- `SkillsWorkspace` 的详情摘要与入口正文已有各自卡片/内容容器；本期只在确实满足“标题直接拥有叙事正文”语义时使用同一 inset，避免重复 padding。

## 4. 产品目标与成功定义

### 4.1 目标

1. 首次进入 Issues 时优先看到未完成 Issue，且当前筛选状态一眼可知。
2. 一次点击即可在全部与未完成之间切换，按钮状态和实际查询完全一致。
3. 详细状态能力保留在代码中，但默认 UI 不暴露。
4. 任意深度 Goal 在所有 picker/trigger 中遵循同一种路径层级样式。
5. Issue、评论与 Goal 正文形成克制、稳定的从属层级，窄宽度不会浪费过多横向空间。
6. 不引入新的状态模型、请求协议或一次性视觉组件。

### 4.2 必赢场景

用户首次进入 Space Issues，分段按钮默认选中「未完成」，请求携带 `state=open,todo,doing`；点击「全部」后实际查询切换为显式 `state=all`，完成与未完成 Issue 都可出现。切换到另一个 Space 或发起退出、完成本地 signed-out 切换时恢复默认「未完成」，同一 Space 内切换页面则保留用户当前选择。详细状态下拉在 UI 中不可见，但其受控实现仍保留。

同一用户随后打开 Goal 筛选、Create Issue、Issue 详情任务卡和 Agent Goal picker：`MyAgents社区 / MyAgents BUGFIX` 与 `../MyAgents BUGFIX/Windows 系统兼容性优化` 都以灰色路径前缀 + 黑色常规字重末级呈现，根目标保持黑色常规字重。进入 Issue/Goal 详情和评论流时，正文相对标题/身份头形成 12px（窄宽 8px）内缩，附件与评论正文共用同一内容基线。

## 5. 范围与反范围

### 5.1 本期包含

- Issue 工具栏新增「全部 / 未完成」分段按钮。
- Issue 初始状态筛选及 Space/logout 边界重置为未完成。
- 详细状态 `CustomSelect` 由文件内静态开关关闭并保留实现说明。
- 把 `GoalPathSelectLabel` 收敛为通用 `GoalPathLabel`。
- 支持 `父 / 子` 与 `../父/子` 两种 label 解析。
- 所有现有 Goal picker 以及 `IssueTaskCard` trigger/options 复用共享 label。
- 新增 Space 叙事内容 inset 语义常量，覆盖 Issue 正文、评论内容块和 Goal context。
- 中英文文案与组件回归测试。
- 宽屏与窄宽 smoke 验证。

### 5.2 明确不做

- 不删除细粒度状态筛选能力。
- 不新增 runtime feature flag、设置项或远端配置。
- 不修改 Issue 状态枚举、状态翻译或 Cloud 查询语义。
- 不修改 Cloud `buildGoalPathLabels`，不让 Desktop 自行重建完整 Goal 树路径。
- 不把 Goal path 拆成新的 API 结构化字段。
- 不全面重排 Space toolbar、Issue drawer、Goal 页面或 Skill 页面。
- 不给所有正文、表单、列表、附件 section 机械添加 padding。
- 除对齐 `src-tauri/src/space_cloud_mock.rs` 的 dev/test 查询语义外，不改生产 Rust 代理、Sidecar、Space Cloud 或 sibling 仓库。

## 6. 交互与视觉规格

### 6.1 Issue 分段按钮

位置：保留当前详细状态选择器所在的第一个筛选位，位于搜索入口之后、Goal selector 之前。

规格：

- 外层高 36px（Tailwind `h-9`），与 toolbar 其他控件一致。
- 两个等宽按钮：「全部」「未完成」。
- 默认「未完成」。
- 选中项使用中性 elevated paper 背景、`--ink` 文字和轻微 shadow；不使用主按钮色或暖色强调。
- 未选项使用 `--ink-muted`，hover 回到 `--ink`。
- 外层使用现有 `--line`、paper token 和圆角体系。
- 两个按钮都必须有 `type="button"` 与准确的 `aria-pressed`。
- 不新增动画位移、滑块或测量逻辑；使用颜色/阴影过渡即可。
- `max-xl` 下把「与我相关」和「创建」的可见文字折叠为保留 accessible name 的图标按钮，Goal selector 保留至少 80px 可点击宽度，按钮文字仍保持 `text-sm`。搜索展开时搜索框固定为 160px，并暂时隐藏创建/刷新动作区；状态与 Goal 筛选继续可见。不得用 resize listener 或 JS 测量解决 800×600 布局。

状态映射：

| UI | `selectedStatus` | 请求语义 |
|---|---|---|
| 全部 | `ALL_ISSUE_STATE_FILTER` | `state=all` |
| 未完成 | `ACTIVE_ISSUE_STATE_FILTER` | `state=open,todo,doing` |

若未来静态开关重新启用详细选择器，它显示 All + 既有 active + 单状态选项，确保两个产品级筛选都有合法选项；分段按钮与详细选择器互斥渲染。

### 6.2 Goal 路径标签

统一渲染规则：

| 输入 | 灰色前缀 | 黑色末级 |
|---|---|---|
| `MyAgents社区` | 无 | `MyAgents社区` |
| `MyAgents社区 / MyAgents BUGFIX` | `MyAgents社区 /` | `MyAgents BUGFIX` |
| `../MyAgents BUGFIX/Windows 系统兼容性优化` | `../MyAgents BUGFIX/` | `Windows 系统兼容性优化` |

细节：

- 末级显式使用 `text-[var(--ink)] font-normal`，不能依赖父容器 `text-current`，也不能加粗。
- 前缀和分隔符统一使用 muted token。
- 单层 Goal 也显式使用黑色常规字重。
- 布局优先保留末级；前缀允许先 truncate，末级在容器仍不足时才 truncate。
- 根容器保留完整 `title={label}`，确保截断后可悬浮查看。
- `label` 仍是完整 plain/accessibility 文本来源；不通过 CSS `::before` 拼装语义内容。
- 共享组件同时接收调用点已有的结构化末级 `leafLabel`（来自 `goal.title` / `goalTitle`），先从完整 label 末尾剥离精确 leaf，再识别 `" / "` 或 `../…/` 前缀。不得只靠最后一个斜杠猜末级，否则 `Docs / API`、`../Docs/API` 等合法 Goal 标题会被误拆。

### 6.3 叙事内容 inset

新增单一语义常量，例如：

```ts
SPACE_NARRATIVE_INSET_CLASS = "px-3 max-sm:px-2"
```

具体名称可按当前代码风格调整，但必须表达“叙事正文”，不能叫通用 `PADDING_CLASS`。

应用边界：

- Issue body：正文容器应用。
- Comment：正文与该评论自己的附件包在同一 inset 内容块内。
- Goal context：相对 Goal 标题应用。
- Skill summary：只有在代码审计确认它是标题直接拥有的只读摘要、且外层未已有等价 inset 时才应用；不得造成双重内缩。

不应用：

- Issue/Goal 列表行；
- 搜索和筛选栏；
- 编辑表单；
- 评论身份头；
- 独立 attachment section/card；
- composer；
- 已由卡片 padding 建立边界的 Markdown entry。

## 7. 架构与实现合同

### 7.1 Owner 与数据流

- `Space.tsx` 继续拥有 Issue query state；初始 `selectedStatus` 使用 `ACTIVE_ISSUE_STATE_FILTER`，并在 `enterSpace` / logout 的本地 session 边界同步恢复未完成，不能等待远端 logout 完成后再重置；普通 Space tab 切换不重置。
- `IssuesWorkspace` 只负责把分段交互翻译成受控 `onStatusChange`。
- `spaceStore` / `spaceCloud.ts` 继续拥有 query normalization 与请求拼装，本期不复制这些逻辑。
- Cloud 继续是 Goal label 的事实源；Renderer 的 `GoalPathLabel` 只负责展示分层。
- `spaceUi.ts` 继续承载跨 Space 页面复用的视觉语义 class。

### 7.2 详细筛选保留方式

在 `IssuesWorkspace.tsx` 定义带说明的文件内常量：

```ts
// Keep the granular status selector compile-live for a future product revisit.
// The current Issue IA intentionally exposes only All and Incomplete.
const ENABLE_GRANULAR_ISSUE_STATUS_FILTER = false;
```

JSX 中以该常量互斥渲染详细 `CustomSelect` 和新分段按钮。禁止：

- 大段注释 JSX；
- `display:none` 同时挂载两套可交互控件；
- 新增全局 config；
- 删除 `statusFilterOptions` 或 `ISSUE_STATUSES` 引用。

### 7.3 React 稳定性

- 继续用 `useMemo` 构造 `statusFilterOptions`，避免退化现有 options identity。
- 分段按钮不需要 effect、本地镜像 state 或测量。
- 新共享 Goal label 必须是纯展示组件，不增加 context/store 依赖。
- 不在 render 中引入不稳定对象作为 effect 依赖。

### 7.4 设计系统红线

- 颜色只使用 CSS token，不硬编码色值或 Tailwind palette。
- 字号只使用 DESIGN.md 七档字阶，不新增任意 px 字号。
- 不使用原生 `<select>`。
- 不增加不必要 overlay；如触及 overlay，必须沿用 `useCloseLayer` / `OverlayBackdrop`。
- 分段控件保持中性，不与 Create 主操作争抢层级。

## 8. 预计改动面

核心实现：

- `src/renderer/pages/space/Space.tsx`
- `src/renderer/pages/space/issues/IssuesWorkspace.tsx`
- `src/renderer/pages/space/GoalPathLabel.tsx`（替代旧文件）
- `src/renderer/pages/space/issues/IssueTaskCard.tsx`
- `src/renderer/pages/space/issues/IssueDetailDrawer.tsx`
- `src/renderer/pages/space/goals/GoalsWorkspace.tsx`
- `src/renderer/pages/space/agents/AgentsWorkspace.tsx`
- `src/renderer/pages/space/issues/CreateIssueDialog.tsx`
- `src/renderer/pages/space/spaceUi.ts`
- `src/renderer/i18n/locales/zh-CN/app.json`
- `src/renderer/i18n/locales/en-US/app.json`

测试按真实影响补充：

- `GoalPathLabel.test.tsx`
- `IssuesWorkspace.test.tsx`
- `IssueDetailDrawer.test.tsx`
- `GoalsWorkspace.test.tsx`
- 必要时相关 snapshot/query 测试

若实现中发现其他 Goal picker 仍直接渲染 `goalPathLabel`，应在不扩大产品范围的前提下复用共享组件，并在执行台账记录。

## 9. 验收标准

### AC1：默认未完成

- 新进入/切换到 Space 与发起 logout 的本地 signed-out 边界后，`selectedStatus === ACTIVE_ISSUE_STATE_FILTER`；远端 logout 延迟或失败不能保留旧值或迟到覆盖新登录后的选择。
- Issue 请求携带 `state=open,todo,doing`。
- 「未完成」按钮 `aria-pressed=true`，「全部」为 false。

### AC2：全部切换

- 点击「全部」调用 `onStatusChange(ALL_ISSUE_STATE_FILTER)`，请求显式携带 `state=all`。
- 受控 props 更新后 active 视觉与 `aria-pressed` 同步。
- 点击「未完成」调用 `onStatusChange(ACTIVE_ISSUE_STATE_FILTER)`。

### AC3：详细状态能力保留但不暴露

- 默认 DOM 不存在详细状态 combobox。
- `statusFilterOptions`、`ISSUE_STATUSES` 和 `CustomSelect` 实现仍在编译路径中。
- 文件内注释明确说明产品选择和恢复入口。

### AC4：Goal 路径统一

- 单层、两层和深层压缩路径全部正确拆分。
- 末级为 `--ink` + normal，无 `font-semibold/bold`。
- 前缀为 muted；深层 `../父/` 全部属于前缀。
- Space filter、Create Issue、Issue Task card、Agent picker 使用同一组件。
- 完整 label 可通过 title 获取。

### AC5：正文层级

- Issue body、comment content block、Goal context 常规宽度为 12px horizontal inset。
- `max-sm` 下为 8px。
- 评论附件与该评论正文共享 inset。
- 身份头、标题、表单和独立 section 不被重复内缩。

### AC6：国际化与设计一致性

- 新文案存在中英文资源，不硬编码 UI copy。
- 无硬编码颜色、任意字号或原生 select。
- 800×600 工具栏仍可操作；新分段控件不把 Goal selector 挤到不可用。

## 10. 测试与验证计划

### 10.1 自动化测试

1. `GoalPathLabel` 组件测试：
   - 根目标；
   - `父 / 子`；
   - `../父/子`；
   - prefix/leaf class、normal weight 与 title；
   - 不误拆普通斜杠文本。
2. `IssuesWorkspace` DOM 测试：
   - 未完成默认 active；
   - 两个按钮的 `aria-pressed`；
   - 点击映射准确；
   - 详细状态 select 默认不存在；
   - Goal selector 与其他 toolbar action 仍在。
3. `IssueTaskCard` / `IssueDetailDrawer`：
   - 深层 Goal label 的 prefix/leaf 渲染；
   - Issue body 与 comment content 使用叙事 inset；
   - 评论附件在同一内容块。
4. `GoalsWorkspace`：Goal context 使用叙事 inset。

### 10.2 命令验证

至少运行：

```bash
npm run test:dom -- --run <targeted tests>
npm run typecheck
npm run lint
npm run build:web
```

若 `npm run test:changed` 能准确隔离当前改动，再追加执行；不得让工作区无关 dirty files 的失败被误报为本需求回归。

### 10.3 视觉 smoke

在可用的本地 renderer/mocked Space 环境检查：

- 常规宽屏 Issues toolbar；
- 800×600 或等价窄窗口 toolbar；
- Goal selector 的两层与深层行；
- Issue body/comment/attachment；
- Goal detail context。

若浏览器控制通道或 mock 数据不可用，必须在交付中明确列出未完成的视觉项，不能把 DOM 测试等同于截图验收。

## 11. 风险与对策

### R1：界面显示“全部”但请求仍是未完成

对策：唯一 state owner 默认使用 `ACTIVE_ISSUE_STATE_FILTER`；用户主动点击「全部」时使用显式 `ALL_ISSUE_STATE_FILTER = "all"`。组件测试验证默认选中态与双向点击映射，store/query 测试继续锁定 `all` 在刷新与分页请求中不被归一化掉。Cloud 的缺省 active 语义保持不变，以兼容 CLI 和旧客户端。

### R2：CustomSelect 选中态把末级继承成错误颜色

对策：`GoalPathLabel` 对末级显式使用 `--ink`，不使用 `text-current`。

### R3：深层压缩路径误解析

对策：调用点把 `goal.title` / `goalTitle` 作为结构化 leaf 传入，组件先剥离精确 leaf 再识别两类前缀；测试锁定 `../父/子`、根标题 `Docs / API` 与深层 leaf `Docs/API polish`。

### R4：固定 inset 在小窗口浪费空间

对策：12px 在 `max-sm` 降为 8px；只应用到叙事内容，不叠加在卡片或表单 padding 上。

### R5：重命名组件遗漏调用点

对策：完成后 `rg "GoalPathSelectLabel|goalPathLabel" src/renderer/pages/space`，审计所有 Goal picker/trigger；typecheck 与依赖 lint 兜底。

## 12. Rollback

- 分段按钮可通过恢复静态常量重新显示详细状态选择器；查询能力未删除。
- 默认筛选可独立在 `ACTIVE_ISSUE_STATE_FILTER` 与 `ALL_ISSUE_STATE_FILTER` 之间调整，不涉及数据迁移或协议变更。
- `GoalPathLabel` 是纯展示组件，回退不改变 API 数据。
- 叙事 inset 是共享 class 的展示层应用，可逐调用点回退，不改变内容结构或持久化数据。

## 13. 执行台账

### 2026-07-15 · 实现启动

- 基线：`c314e55c17d0df7c29450c8e3a05a915a693baf9`（`feat(chat): normalize file patch render model`）。
- 模式：PRD 驱动开发；实现、验证、三视角交叉审查和提交均由本次执行完成。
- 范围：仅 Desktop Renderer 的 Space Issue 筛选、Goal path label、叙事正文 inset、中英文资源与对应测试；不修改 Rust、Sidecar 或 Space Cloud。
- 既有抽象：`Space.tsx` query owner、Cloud 已支持的显式 `state=all`、`ACTIVE_ISSUE_STATE_FILTER`、`CustomSelect`、既有 Goal label 数据、`spaceUi.ts` 视觉常量、DESIGN token。
- 新概念预算：0。分段按钮是现有查询的另一种受控入口；Goal label 是现有共享组件的泛化命名；叙事 inset 是现有 Space UI 视觉常量的语义补充。
- 红线：不夹带工作区既有无关修改；不新增 Cloud/API 状态；不硬编码颜色或任意字号；不以隐藏挂载两套控件代替互斥渲染；不复制查询归一化或 Goal path 构造。
- 验收：以本文 AC1—AC6、targeted DOM tests、typecheck、lint、build、可用时的宽/窄视觉 smoke 和 `cross-review-code` 三视角结论为准。

### 2026-07-15 · 首轮交叉审查与修复

- Requirements 与 Architecture 共同发现 800×600 下固定宽 toolbar 会把 Goal selector 挤到不可操作；Adversarial 进一步复现搜索展开时 flex basis 不会按原假设收缩。最终在 toolbar owner 用 `max-xl` CSS 折叠次要按钮文字、为 Goal selector 保留 80px 最小宽度；搜索展开时固定为 160px并隐藏动作区，筛选仍可见。按钮保持 DESIGN 要求的 `text-sm`，没有增加 JS 测量或 layout state。
- Adversarial 发现选择「未完成」后切换 Space / logout 会继承状态。已在 `enterSpace` / logout 边界重置 `selectedStatus`，同一 Space 内 tab 切换继续保留用户选择，并增加真实状态序列测试。
- Adversarial 发现合法 Goal title 可包含路径分隔符。已让 `GoalPathLabel` 强制消费调用点的结构化 leaf，移除无结构字符串猜测；新增根标题和深层含斜杠 leaf 测试。
- 修复后 targeted DOM：5 files / 33 tests PASS；typecheck PASS。三路 reviewer 使用同一 reviewer identity 对最终修复做了针对性复审，未发现剩余代码 blocker。

### 2026-07-15 · 实现完成与交付证据

- 实现结果：
  - Issue 状态默认值改为全部；跨 Space 和 logout 回到全部，同一 Space 内 tab 切换保留当前选择。
  - 细粒度状态 `CustomSelect` 通过带说明的文件内静态常量保持 compile-live，默认 UI 只展示「全部 / 未完成」。
  - `GoalPathSelectLabel` 收敛为强制接收结构化 `leafLabel` 的 `GoalPathLabel`，并覆盖 Space filter、Create Issue、Issue task 与 Agent picker。
  - `SPACE_NARRATIVE_INSET_CLASS` 覆盖 Issue body、评论正文及其附件、Goal context，以及标题直接拥有的 Skill 摘要。
  - 800px 宽度下用纯 CSS 收缩搜索区、保留筛选区并在搜索展开时隐藏次要动作区；没有新增 viewport state 或测量逻辑。
- 自动化验证：
  - targeted DOM：5 files / 33 tests PASS。
  - `npm run typecheck`：PASS。
  - `npm run lint`：PASS；仅保留仓库既有 `chatSuggestions.ts` orphan warning。
  - `npm run build:web`：PASS；仅有仓库既有 dynamic-import / chunk-size warnings。
  - `npm run test:changed`：本需求修复前曾通过 106 files / 819 tests；最终复跑因工作区并发的非本需求 server 改动扩大到 192 files，其中 `proxy-state.unit.test.ts` 与 `mcp-live-mutation-failure.unit.test.ts` 共 3 个用例失败。本需求 targeted tests 全绿，未修改或吸收这些无关失败。
- 视觉验证：已完成 800px 静态空间预算与 DOM responsive contract 验证；当前执行环境的 in-app Browser 列表为空，未能进行真实截图 smoke。交付后仍建议在桌面端人工复验常规宽屏、800×600、深层 Goal option 与正文 inset。
- 交叉审查：requirements、architecture、adversarial 三视角最终均为 PASS；此前发现的窄窗溢出、按钮错误字阶、跨 Space 状态泄漏与 Goal slash 歧义均已关闭。唯一残余是上述真实 Browser 视觉证据限制，不构成代码 blocker。
- 提交：实现与本 PRD 将随本次 handoff commit 一并提交；最终 hash 以交付消息为准。

### 2026-07-16 · 「全部」查询契约回归修复

- 用户实机证据：选中「全部」时已完成 Issue 仍不出现，结果与「未完成」一致。
- 双路径根因：Desktop 把产品态「全部」编码为空字符串，Store/API 随后省略 `state`；Cloud 的长期兼容契约会把缺省 `state` 解释为 `open,todo,doing`，只有显式 `state=all` 才返回全部五个非归档状态。
- 同根验证盲点：Rust Space mock 把缺省 `state` 当作不限状态，与生产 Cloud 不一致，因此先前 mock/DOM smoke 无法揭示该回归。
- Repair radius：Desktop 首次进入、点击全部、跨 Space/logout 重置、手动/远端/创建/详情变更刷新和分页统一携带显式 `all`；Rust mock 的缺省与 `all` 语义对齐 Cloud。Cloud 本身、CLI 缺省 active 行为、Registered Agent subscription 均不修改。
- Characterization：Renderer 旧实现出现 4 个预期失败；Rust mock 旧实现会错误返回 terminal fixture，新增契约测试出现 1 个预期失败。
- 实现结果：新增显式 `ALL_ISSUE_STATE_FILTER = "all"`，并让初始进入、点击「全部」、跨 Space、成功 logout、刷新与分页都保留该值；Rust mock 同步 Cloud 的缺省 active / 显式 all / 排除 archived 契约，补齐 legacy archived fixture 的 `archivedAt`。生产 Cloud、Rust 代理、CLI 与 subscription 路径均未改动。
- 自动化验证：targeted DOM 13/13 PASS；helper/store unit 62/62 PASS；`npm run test:changed` 13 files / 114 tests PASS；Rust `space_cloud_mock::tests` 13/13 PASS；`npm run typecheck`、`npm run lint`、`npm run build:web`、Rust fmt check 与 Clippy 全部 PASS。仅有仓库既有 orphan、dynamic-import、chunk-size 与 Clippy warning。
- 交叉审查：requirements、adversarial、architecture 三视角最终均为 PASS。审查中发现并修复 mock 的 archived legacy fixture 缺少 `archivedAt`、PRD scope 表述矛盾、logout 重置缺少回归测试，以及 dormant 细粒度 selector 缺少显式 All 选项。
- 运行时证据边界：本次未抓取登录态生产请求响应；结论由用户实机回归、Cloud 权威实现与 route test、独立双路径代码调查以及本地前后端契约测试共同支撑。
- 提交：修复与本 PRD 将随本次 handoff commit 一并提交；最终 hash 以交付消息为准。

### 2026-07-16 · 默认值改为「未完成」开发契约

- 必赢场景：首次进入 Issues、切换到另一个 Space、发起 logout 并完成本地 signed-out 切换后，分段按钮默认选中「未完成」，首个查询携带 `state=open,todo,doing`；用户点击「全部」后仍显式发送 `state=all` 并能看到已完成 Issue；同一 Space 内切换页面继续保留用户已选筛选。远端 logout 延迟/失败不得让旧 `all` 穿越到新登录，也不得用迟到响应覆盖新选择。
- 复用的既有抽象：`Space.tsx` 的唯一 `selectedStatus` owner、`ACTIVE_ISSUE_STATE_FILTER`、`ALL_ISSUE_STATE_FILTER`、`IssuesWorkspace` 受控分段按钮与既有 query/cache 链路。
- 反向边界：不撤销显式 `state=all` 契约；不修改 Cloud、Rust proxy/mock、CLI、subscription、Issue 状态枚举、筛选按钮布局或视觉；不新增用户偏好持久化。
- 新概念清单：0。只调整既有 owner 的默认值与 session 边界 reset 值。
- 触及的红线：前端状态 owner 必须保持单一；不新增 effect/镜像 state；测试必须覆盖首次查询、跨 Space、logout 与双向切换；只提交本批次文件。
- Batch 1：默认未完成（单批次闭环）。
  - [x] 把 `Space.tsx` 初始值、`enterSpace` 与 logout 本地边界 reset 改为 `ACTIVE_ISSUE_STATE_FILTER`。
  - [x] 更新 switching / workspace DOM 回归测试，继续锁定「全部」映射为显式 `all`。
  - [x] 完成 targeted tests、typecheck、lint、build 与 `test:changed`。
  - [x] 完成 requirements / adversarial / architecture 三视角 repair review。
- 当前批次 Review 基线：`36393bc928adc88ab82c446dacf17f8bb74ec13f`。
- 预期范围：本 PRD、`Space.tsx`、`Space.switching.test.tsx`、必要时 `IssuesWorkspace.test.tsx`；不修改 Rust 或 Cloud。
- 待用户决策：无。
- 进展日志：2026-07-16 已根据用户实机体验确认默认产品意图并完成契约；测试先行得到旧实现 3 个预期失败，改动唯一 query state owner 后 targeted DOM 首轮 2 files / 13 tests PASS。三视角初审中 adversarial reviewer 发现 logout 远端 await 竞态；已把 reset 前移到 store 同步 local signed-out 边界，并增加 deferred success / remote failure / late success 不覆盖新选择的覆盖。
- 最终验证：targeted DOM 2 files / 14 tests PASS；`npm run test:changed` 5 files / 22 tests PASS；`npm run typecheck` PASS；`npm run lint` PASS（仅仓库既有 `chatSuggestions.ts` orphan warning 与 baseline-browser-mapping 提示）；`npm run build:web` PASS（仅仓库既有 dynamic-import / chunk-size warnings）。
- 交叉审查：requirements 与 architecture 首轮 PASS；adversarial 首轮发现 1 个 logout async race blocker，修复后由同一 fresh Codex reviewer follow-up 确认 Critical/Warning 均为 0。三路 required lens 完成。
- 视觉证据：当前 in-app Browser 列表为空，无法执行真实 WebView 截图 smoke；人工只需复验首次进入默认高亮「未完成」、点击「全部」仍能看到已完成 Issue。
- 提交：本批次实现与 PRD 将一并提交，最终 hash 以交付消息为准。
