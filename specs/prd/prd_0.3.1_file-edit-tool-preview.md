---
type: prd
status: implemented
created: 2026-07-15
updated: 2026-07-16
scope: "统一优化 Chat 内 Edit / Write 文件变更与 Bash 命令执行的展开预览：文件变更采用方案 A 纸上校样，Codex 原生多文件按协议顺序纵向分组；Bash 采用单一模拟终端，连贯呈现命令、运行状态、stdout/stderr 与退出元信息。首期不新增复制变更/输出能力，不靠歧义文本猜多文件边界，也不改变工具执行、权限、消息分组、附件管道、工作区 IO 或会话协议。"
issue: "用户需求：Edit / Write 展开体的代码、增删标记与元信息混在一起；Bash 输入被整段任意折行，输入、输出与状态又拆成两坨纯文本。希望对标 Codex CLI / Desktop 的扫描效率，同时保持 MyAgents 设计系统，并让工具过程本身清楚、可信、好读。"
research: "specs/playground/file-edit-tool-preview.html"
review: "implemented-reviewed：方案 A、单一 Bash 模拟终端与 Codex 单工具多文件纵向分组已交付；requirements / adversarial / architecture 三镜 review 完成。Builtin + Codex 走结构化强验收，Claude Code / Gemini 数据不足时诚实回退；ANSI 无跨 Runtime 保真证据时保持 inert plain text。真实 WKWebView / WebView2 明暗与窄宽视觉矩阵仍是发布门禁。"
---

# PRD 0.3.1：Edit / Write / Bash 工具代码与文本预览重构

## 0. 执行须知（给空 session 的你）

本 PRD 可以独立驱动实现，但动手前必须完成以下读取与核验：

1. 读 `CLAUDE.md`、`specs/ARCHITECTURE.md`、`specs/DESIGN.md`。
2. 读 `specs/tech_docs/multi_agent_runtime.md`，因为文件变更与 Bash 都要覆盖 builtin、Claude Code、Codex、Gemini Runtime。
3. 读 `specs/tech_docs/tool_attachment_pipeline.md`，确认本需求不得改动 attachment owner、SSE spill 或文件安全边界。
4. 读当前 SDK 类型源码：
   - `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`
   - `FileEditInput` / `FileEditOutput`
   - `FileWriteInput` / `FileWriteOutput`
   - 当前 Managed Codex 版本以 `src/shared/managed-codex-runtime.json` 为准；用该版本 `codex app-server generate-ts --out <temp-dir>` 生成协议，并核对 `ThreadItem`、`FileUpdateChange`、`PatchChangeKind`、`FileChangePatchUpdatedNotification`
5. 从以下符号开始追现有实现，不要按文件名猜行为：
   - `groupContentBlocksForDisplay`
   - `BlockGroup`
   - `ProcessRow`
   - `getToolSummaryNode`
   - `ToolUse`
   - `FilePatchTool`
   - `BashTool`
   - `ExpandableResult`
   - `CodeBlock`
   - `buildFilePatchDisplayDescriptor`
   - `resolveFilePatchDisplay`
   - `handleToolResultComplete`
6. 打开研究原型 `specs/playground/file-edit-tool-preview.html`，逐一切换：
   - A / B / C 三种视觉方向
   - Edit / Write / Codex 多文件变更 / Bash 四种数据场景
   - 明暗主题、展开/收起、多文件纵向分组、文件“更多”菜单与“展示全部”
7. 当前仓库版本为 `0.3.0`，目标开发线为 `0.3.1`。本 PRD 不授权顺手修改不相关的会话、MCP、Goal/Task 或 turn queue 代码。

实现不得把 playground 的静态 HTML/CSS 直接复制进产品。原型用于确定层级、密度与交互；产品实现必须复用现有 token、i18n、文件动作、工具状态与组件边界。

---

## 1. 背景

MyAgents 已能把 builtin SDK、Claude Code、Codex、Gemini 的文件修改行为统一呈现在 Chat 工具流中。但当前展开体仍以“把原始文本塞进一个 `<pre>`”为核心：

- 文件路径、增删统计在外层 ProcessRow、展开体顶栏和 change 子标题中重复出现；
- unified diff 的旧行号、新行号、`+/-` marker 与代码正文都在同一段文本里；
- Edit 的 old/new input 被渲染成整块红字与整块绿字，扫描替换边界困难；
- 长行默认折行，导致行号、marker、代码的水平关系消失；
- Write 被输入侧一律推断成 `add`，覆盖既有文件时也显示为纯新增，语义可能失真；
- Codex 有较完整 unified diff，builtin SDK 输出已有 `structuredPatch`，Gemini 又是另一种扁平 diff；当前展示质量因此随 Runtime 漂移；
- `ExpandableContainer` 只限制可视高度，不限制一次挂载的 DOM/文本规模。

Bash 也存在同源的信息结构问题：

- `BashTool` 的输入虽然使用 `white-space: pre-wrap`，但 `break-all` 会把一整行 shell 命令在任意字符处折断；Runtime 传入的 `/bin/zsh -lc "..."` 包装、命令主体和参数因此挤成一坨；
- Codex 已在 `commandActions[]` 提供去掉外层 shell 包装后的语义命令，但当前 renderer 没有使用；
- 输入和输出分别套一块高权重黑色圆角卡片，cwd、PID、耗时、exit code 又悬在两者之间，用户难以把它们识别为同一次终端执行；
- stdout/stderr 被拼成一段纯文本，stderr 只靠人为插入 `[stderr]`；JSON、unified diff、ANSI terminal stream 与普通日志都走同一个无高亮 `<pre>`；
- initializing、running、completed、non-zero exit、stopped、timeout、background 等状态没有形成同一条可追踪的执行叙事。

用户看到的结果是：代码、协议标记和工具元信息竞争注意力，难以快速回答三个最重要的问题：

1. 改了哪个文件？
2. 改了哪几行？
3. 旧内容和新内容分别是什么？

这不是单纯的红绿配色问题，而是信息 owner 与渲染模型错位。

---

## 2. 产品目标

### 2.1 核心目标

在不改变工具执行架构的前提下，把 Edit / Write 与 Bash 的展开体升级成适合聊天宽度的专业代码/文本查看体验：

- 代码变更成为视觉主角；
- 工具状态、文件路径、统计各有唯一 owner；
- 旧行号、新行号、marker、代码正文结构化分列；
- builtin / Claude Code / Codex / Gemini 尽可能获得一致的展示能力；
- 小改动一眼看懂，大改动不会拖垮 Chat；
- 视觉延续 MyAgents 的暖纸设计系统，而不是在工具区嵌入一块突兀的 IDE。
- Bash 使用一个完整、连贯的模拟终端，把命令、运行状态、输出和退出信息放回同一执行上下文；
- Bash 命令优先使用 Runtime 已提供的语义结构改善换行和高亮，复制仍完全不属于本期；
- Bash 输出只在类型可信时渐进增强，无法识别时保持诚实、清晰的终端纯文本。

### 2.2 成功标准

用户展开一次工具卡后，在无需阅读原始 JSON 或手工解析 unified diff 的情况下，可以：

- 2 秒内定位文件名、变更类型和增删规模；
- 区分旧行号、新行号、增删 marker 与代码内容；
- 多文件修改时按 Runtime 提供的顺序从上到下阅读，每个文件只出现一次并形成清楚的独立分组；
- 长 patch 先看关键变更，需要时一次“展示全部”；
- 在浅色、深色和窄窗口下保持可读。
- Bash 中一眼看清执行了什么、在哪里执行、当前处于什么状态、产生了哪些 stdout/stderr、最终如何退出；
- 长 shell 命令在语义边界换行，不再在单词、路径或引号中间任意折断；
- JSON、diff 和 shell 命令获得可信高亮，普通日志不会被错误猜成某种编程语言。

### 2.3 非目标

本需求不做：

- 工具执行、审批、权限、撤销、重新应用或 patch 编辑；
- 独立代码审阅页面、Git 工作区 diff 或 commit review；
- 新的 HTTP/SSE 端点、新消息类型或新的持久化大对象；
- 新增“复制当前变更”“复制完整输出”“复制原始命令”等专用按钮或快捷动作；现有文件“更多”菜单内既有的“复制路径”不属于本期新增能力，保持原状；
- 工作区文件读写新路径；文件操作继续复用现有 FileAction / workspace file service；
- ToolAttachment 管道改造；
- Message 历史恢复源、BlockGroup 分组规则或 ProcessRow 状态机重写；
- NotebookEdit 的富 diff 重构。NotebookEdit 保持现状，后续在 notebook 单元格语义下单独设计；
- 把 B 双栏或 C 终端方案与 A 同时做成生产设置。首期只实现方案 A。
- 把 C 当作系统暗夜主题。A 自身必须同时拥有明亮版与暗夜版；C 是独立的终端视觉研究。
- 把 Bash 静态工具结果改造成可输入的真实 PTY，或复用 `TerminalPanel` / xterm 的进程、键盘、resize 生命周期；
- 为了 Bash 输出做激进的语言猜测、日志语义解析或通用 IDE；
- 为 Codex 多文件结果从人类可读 completed result 文本中正则猜文件边界。没有结构化 `changes[]` 就回退现状/原始结果，不做多文件增强。

---

## 3. 当前技术事实与边界

### 3.1 现有显示链路

```text
Runtime 原始事件
  ├─ builtin Claude Agent SDK
  ├─ Claude Code external runtime
  ├─ Codex item.fileChange
  └─ Gemini ACP tool call
        ↓ runtime adapter / agent-session 归一化
ToolUseSimple { name, input, inputJson, parsedInput, result, display, status... }
        ↓ Message.groupContentBlocksForDisplay
BlockGroup（连续 thinking/tool 的卡片 owner）
        ↓
ProcessRow（工具名、状态、摘要、折叠交互 owner）
        ↓ 展开
ToolUse（按标准 tool name 分派专用 renderer）
  ├─ EditTool / WriteTool → FilePatchTool（文件 patch 展开体）
  └─ BashTool → ExpandableResult（命令执行展开体）
```

正确方案必须延续这条链路。不得在 Message、BlockGroup 或 Runtime adapter 旁边新建一套“编辑历史卡片”路径。

### 3.2 当前组件 owner

| 层级 | 当前职责 | 本需求后的职责 |
|---|---|---|
| `Message.tsx` | 消息内容与附件布局 | 不变 |
| `contentBlockDisplay.ts` | thinking/tool 连续分组 | 不变 |
| `BlockGroup.tsx` | 工具过程组外壳与长组折叠 | 不变 |
| `ProcessRow.tsx` | 工具名、状态、摘要、展开/收起 | 继续是唯一工具 chrome owner；仅允许为 file patch 展开体提供全宽布局 |
| `toolBadgeConfig.tsx` | 外层工具名称、文件摘要、总统计 | 继续产出外层摘要，数据必须与展开体共用同一解析真相 |
| `ToolUse.tsx` | 专用 tool renderer 分派 | 不变 |
| `EditTool.tsx` / `WriteTool.tsx` | `FilePatchTool` 轻包装 | 保持轻包装 |
| `FilePatchTool.tsx` | 文件元信息、原始 old/new/content/diff | 重构为文件变更查看器入口 |
| `BashTool.tsx` | 两块 code surface + 中间元信息 + plain `ExpandableResult` | 重构为单一模拟终端入口；拥有 Bash 状态与输入/输出分区 |
| `markdown/CodeBlock.tsx` | Markdown fenced code 的 Prism 高亮与主题 | 复用其现有 `react-syntax-highlighter` 依赖和 syntax theme；不复制一套 token 色表 |
| `tools/utils.tsx::ExpandableResult` | 多工具共享的纯文本展开容器 | 保持通用 plain-text fallback，不塞入 Bash/JSON/diff 专属识别逻辑 |
| `shared/toolDisplay/filePatch.ts` | 从多形态 input/display 解析 descriptor/body | 扩展为权威的纯数据归一层；不得引入 React 或 runtime 专属依赖 |

### 3.3 Runtime 输入现状

| Runtime | 当前进入 Chat 的形态 | 已有优势 | 当前缺口 |
|---|---|---|---|
| builtin SDK | `Edit(old_string,new_string)` / `Write(content)`；结果可能含 `tool_use_result.structuredPatch` | SDK output 有准确 hunk/行号、Write create/update、gitDiff | 当前 shared parser 只看 input/display，未消费 output structuredPatch |
| Claude Code | 原生 tool name/input/result 进入 external session facade | 与 builtin tool 心智接近 | 必须以真实事件确认结果是否同样保留 structured output |
| Codex | `item.fileChange` 归一为 `Edit` + `input.changes[]` unified diff | 多文件、hunk 和统计较完整 | 当前先重复列路径，再纵向输出原始 change 卡片；0.144.1 的 `patchUpdated` snapshot 尚未消费，旧 `outputDelta` 已被协议标为不再发送 |
| Gemini | `write_file` / `replace` 映射为 Write/Edit；ACP diff 常被扁平为文本 | 标准 tool name 已归一 | 路径/input 不足、结果 diff 形态未进入 descriptor，常退化 raw fallback |

### 3.4 工具类型与文件数量不是一回事

当前产品中的标准专用 renderer 只有 `Edit` 和 `Write`：

- builtin SDK 的 `Edit` / `Write` input 都只有一个 `file_path`，所以一次调用对应一个文件；
- `MultiEdit` 仍出现在 workspace refresh 和权限相关 allowlist 中，属于兼容/历史 surface；`ToolUse.tsx` 没有 `MultiEdit` 专用 renderer，本 PRD 不把它当作新 UI 类型；
- Codex 的一个 `item.fileChange` 可以包含 `changes[]` 多个文件。adapter 会把整个 item 归一成一个名为 `Edit` 的 `ToolUseSimple`，所以 `FilePatchDisplay.changes.length` 可以大于 1；
- 因此 playground 的“Codex 多文件”是一个数据基数场景，不是名为 `Multi-file` 的工具，也不是建议新增的新 tool type。

产品实现以结构化 `changes.length` 决定是否进入多文件纵向分组，不能以 `tool.name === 'MultiEdit'` 决定。

这一结论已经过四层实证，不再是待验证假设：

1. `src/shared/managed-codex-runtime.json` 当前锁定 Codex `0.144.1`。
2. 用该二进制执行 `codex app-server generate-ts` 得到的 v2 协议中：
   - `ThreadItem` 的 `fileChange` 分支是 `{ id, changes: Array<FileUpdateChange>, status }`；
   - `FileUpdateChange` 是 `{ path, kind, diff }`；
   - `PatchChangeKind` 支持 add、delete、update，update 可带 `move_path`；
   - `FileChangePatchUpdatedNotification` 同样携带 `changes: Array<FileUpdateChange>`。
3. `src/server/runtimes/codex.ts` 在 `item/started` 只发布轻量首路径，避免把可能变化的 started diff 当成最终事实；`item/completed` 通过既有 `tool_use_stop` 边界发布完整 `changes[]`，由现有 external-session 持久化与 renderer stop 事件原子覆盖 started input。没有新增 SSE 事件或 Runtime 专用 UI 协议。
4. `src/server/__tests__/codex-app-server-protocol.unit.test.ts` 已有双文件 fixture；本机 unified log 也存在单个 `fileChange` 同时记录 2、3、5 个文件的真实事件。

此外，当前 `FilePatchDisplayDescriptor.changes[]`、`summary.files`、`descriptorFromCodexChanges()` 和 `materializeCodexDiff()` 已经是数组模型。用户提供的 Session `2d6ec8dc-7bad-4c6b-a393-2fcdafb5ebff` 又验证了一个真实 `Edit`（tool use id `exec-c2db7ffc-658a-40b5-91a3-70ceb932cbbc`）的 `input.changes[]` 按顺序包含：

1. `index.html`
2. `src/account.ts`
3. `src/analytics.ts`
4. `src/main.ts`

这 4 个 change 在同一 tool input 中已经有独立 `path`、`kind`、`diff`，所以 UI 不需要解析 completed result 的人类可读字符串，也不需要制造 tab 状态。首期直接沿用数组顺序纵向渲染，每个文件一组；若某条消息没有可靠的结构化 `changes[]`，则不启用多文件增强。

### 3.5 Bash 输入与结果现状

当前 `BashInput` 的稳定字段是 `command`，并可能包含 `description`、`timeout`、`run_in_background`。外部 Runtime 还会在既有 `parsedInput` / `inputJson` 中附带 `cwd` 和 `commandActions[]`；Codex 的 action 至少包含 `read`、`listFiles`、`search`、`unknown`，每项均保留可展示的 `command`。

当前结果有两种主要形态：

- builtin SDK JSON wrapper：`{ stdout, stderr, interrupted }`；
- external Runtime 文本结果 + `resultMeta { exitCode, durationMs, cwd, processId, status }`。

真实 Session 同时验证了：

- Codex 输入会保留原始 `/bin/zsh -lc "..."`，但 `commandActions[]` 能提供更干净的语义命令；
- completed 结果已有 cwd、PID、耗时、exit code 与 status；
- 输出可以是数百字普通文本，也可以超过一万字符，必须受统一长内容预算约束。

因此 Bash 的正确归属是 renderer 内的静态 transcript view model，不需要新 Runtime 协议。只有 ANSI 是否跨 Runtime 保真仍需用真实 fixture 验证。

### 3.6 已确认的 SDK 类型事实

当前 `@anthropic-ai/claude-agent-sdk` 类型定义中：

- `FileEditInput`：`file_path`、`old_string`、`new_string`、`replace_all`；
- `FileWriteInput`：`file_path`、`content`；
- `FileEditOutput`：包含 `filePath`、`oldString`、`newString`、`originalFile`、`structuredPatch[]`、`gitDiff`、`userModified`、`replaceAll`；
- `FileWriteOutput`：包含 `type: create | update`、`filePath`、`content`、`structuredPatch[]`、`originalFile`、`gitDiff`、`userModified`。

`agent-session.ts` 当前会在 SDK user message 带有对象形态 `tool_use_result` 时优先 JSON.stringify 到 `tool.result`。因此首选动作是扩展 shared parser 读取已经存在的结果，不是再发一份新事件。

---

## 4. 设计方向研究

完整可交互研究见：`specs/playground/file-edit-tool-preview.html`。

### 4.1 方案 A：纸上校样（推荐，首期实现）

暖色 paper surface 上的 unified diff。每行固定为四列：

```text
旧行号 | 新行号 | marker | code
```

特点：

- 增删使用低饱和行底色、左侧细轨和 marker；
- 代码仍以正常 ink/syntax token 显示，不把整行代码染成红字/绿字；
- hunk 定位信息由结构化范围转译成自然语言，使用低权重中性色；不直接暴露 `@@ -a,b +c,d @@` 协议文本；
- 单列天然适配 768px Chat 主列；
- 与现有暖纸、圆角、边框、阴影层级连续。

这是默认方案，因为它在扫描速度、窄宽适配和品牌连续性之间最均衡。

方案 A 必须跟随 MyAgents 全局主题：

- 明亮版使用暖白纸面与低饱和红绿 wash；
- 暗夜版使用现有暖黑/炭褐 paper token、较亮的 marker 和半透明行级 wash；
- 两个主题共享完全相同的信息层级、行模型、间距和交互；
- 暗夜版不是把 viewer 替换成纯黑终端，也不是自动切换到方案 C。

### 4.2 方案 B：双栏审阅

Before / After 并排，适合复杂替换和独立审阅页。

优点：旧、新版本关系直观。缺点：聊天宽度下每栏过窄，长代码需要两个横向滚动上下文；移动端必须保留超宽画布或改成上下堆叠，认知连续性下降。

结论：不作为 Chat 默认，不在首期实现。将来若有独立审阅面板，可复用同一 `FilePatchRenderModel` 实现。

### 4.3 方案 C：终端聚焦

高对比黑底 unified diff，接近 Codex CLI 的扫描效率。

优点：marker 和行级变更最醒目。缺点：在暖纸 Chat 中产生明显材质跳变，工具块权重过强，暗色块会压过 AI 最终回答。

结论：不作为默认，也不等于系统暗夜主题。未来可以作为“专注查看”浮层的视觉参考，但不是本 PRD 范围。

### 4.4 决策矩阵

| 指标 | A 纸上校样 | B 双栏审阅 | C 终端聚焦 |
|---|---:|---:|---:|
| 768px Chat 适配 | 5 | 2 | 5 |
| 替换前后对照 | 4 | 5 | 4 |
| MyAgents 设计连续性 | 5 | 4 | 2 |
| 长行处理 | 5 | 2 | 5 |
| 实现/维护单一模型 | 5 | 3 | 5 |
| 默认推荐 | **是** | 否 | 否 |

### 4.5 Bash：完整模拟终端（已定稿）

Bash 不套用 A/B/C 的文件 diff 方案。它使用一个完整但只读的模拟终端 surface：

```text
┌─ Bash · /bin/zsh ─────────────── running / completed / failed ┐
│ $ 语义化命令                                                  │
│   在安全的 shell 运算符边界续行                               │
│ ──────────────────────────────────────────────────────────── │
│ stdout / stderr / empty / streaming output                    │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│ cwd · duration · PID · exit code / timeout / interrupted       │
└───────────────────────────────────────────────────────────────┘
```

它“像终端”是因为输入、输出和执行状态处于同一个连续表面，而不是因为使用纯黑背景或真的启动 PTY：

- 明亮主题使用暖灰炭色 terminal surface，暗夜主题使用更深的暖黑；均禁止纯黑；
- terminal header 展示 shell 与当前状态，状态同时使用文字/图标，不只用颜色；
- 输入区、输出区和 footer 用细分隔线与留白分区，不再各自套卡片、阴影和大圆角；
- 内部只有一个纵向滚动 viewport；长行允许横向滚动，外层 Chat 不横向溢出；
- 命令、输出和元信息都使用现有七档字阶与 `--font-code`；中文状态与标签仍用 UI 字体；
- 视觉上优先可读和稳定，不做光标闪烁、打字机、扫描线、霓虹、glow 或持续动画。running 只使用克制的状态指示和已有 loading motion；
- 全部状态共用同一骨架，状态变化不得导致 surface 结构跳动。

---

## 5. 目标信息架构

### 5.1 外层 ProcessRow

外层继续负责：

- 工具 icon；
- 工具名：Edit / Write；
- 单文件时文件名，多文件时“N 个文件”；
- 本次工具调用的总统计；
- running / completed / failed / stopped 等状态；
- 展开/收起。

Bash 外层同样继续由 ProcessRow 负责工具名、shell 摘要、running/completed/failed/stopped 状态与展开/收起。展开体不得再重复一个同等权重的“Bash”标题。

外层不得显示绝对路径。外层不新增第二组操作按钮。

### 5.2 展开体文件栏

展开后首行只承载“当前文件”信息：

- 文件图标；
- 主标签：basename；
- 次标签：相对父目录或可辨识的最短上下文；
- 当前文件的变更类型：新建、修改、删除、移动、写入；
- 当前文件的 `+N / −M`。

完整路径只通过 tooltip/title 或现有 FilePath 菜单提供，不把 `/Users/...` 长路径当作视觉标题。

工具名和总统计不在这里重复。

#### 右上角动作：只保留“更多”

用户已明确撤回新增的“复制当前文件变更”能力。文件栏右侧固定只有一个 **更多** icon button：不自己维护一套菜单，复用 `FileActionContext.openFileMenu()` 与现有 `ContextMenu`。

   - 菜单项与当前文件路径菜单一致：预览、复制路径、引用、打开、打开所在文件夹、在文件目录中展示；
   - “在文件目录中展示”仍只在 Chat host 提供 `onRevealInTree` 且路径属于 workspace 时出现；
   - 预览能力继续由 `isPreviewable` / image / rich doc 判断；
   - 文件不存在、路径未解析或不安全时遵守当前 `FilePath` 的 gate，不提供看似可点但必然失败的菜单。

当前 `FilePath` 内已经包含 `resolveFileActionTarget → checkFileTarget → openFileMenu` 的正确路径归一与存在性判断。实现 toolbar 时应把这段能力抽成同目录的可复用 hook/helper，让 `FilePath` 和“更多”按钮共享；不得复制归一逻辑，也不得另写菜单 items。

“更多”菜单中的既有“复制路径”保持现状，因为它属于 FileAction 已有能力；本 PRD 不新增复制 diff、文件内容、Bash 命令或 Bash 输出的功能。

### 5.3 多文件纵向分组

当 `changes.length > 1`（当前主要来源是一个 Codex `item.fileChange` 中包含多个 change）：

- 不显示一组裸路径列表，不显示 file tabs；
- 按 `changes[]` 协议顺序从上到下渲染，每个 change 是一个紧凑文件组；
- 每组只有一条文件栏，显示 basename、最短可辨识父路径、operation、该文件统计和“更多”；紧接该文件 diff viewport，不再在 body 内重复一次完整路径与 `update` 文本；
- basename 重名时追加最短可区分父路径；
- 每个文件组使用完整独立的紧凑卡片（同一套边框、圆角与 `shadow-xs`），文件卡之间保留 12px section gap；不得用共享 outer surface + `divide-y` 把相邻文件粘成一块；
- 每组有独立的行预算和“展示全部”状态；
- 文件数较多时仍保持一个 ProcessRow 展开体和一个滚动阅读方向，不制造 tab 选择状态；
- 只在结构化 `changes[]` 存在且每项具备独立 path/diff 时启用。无法可靠区分时回退 raw result，本期不从 completed result 文本猜边界；
- 长列表的性能通过只物化各组初始预算、按组“展示全部”解决，而不是隐藏未选中的文件。
- 删除/移动必须用图标或文字，不得只靠颜色表达。

不得新增 `Multi-file` tool name；builtin Edit/Write 的单文件展示和 Codex 的多 change 展示共用同一个 viewer。

### 5.4 Diff viewport

每行使用结构化网格：

| 列 | 内容 | 规则 |
|---|---|---|
| old line | 旧文件行号 | 无值时留空，不造假 |
| new line | 新文件行号 | 无值时留空，不造假 |
| marker | `+` / `−` / 空 | 独立可选择文本列，不混进 code |
| code | 原始代码 | `white-space: pre`，不自动折行 |

统一规则：

- 横向滚动发生在一个 code viewport 内；
- 行号 gutter 保持对齐，必要时 sticky；
- 代码选择只作用于真实 code text；行号、marker 等视觉辅助列使用 `user-select: none`，避免选择结果混入伪 patch；
- hunk header、折叠上下文不是代码行，不占用伪造行号；可信 hunk 范围显示为“第 N 行附近 · 原 A 行 → 新 B 行”，起始行变化时分别说明旧/新起点，无法解析时隐藏该元数据行；
- 语法高亮是渐进增强：无法识别语言或超过预算时回退普通 code token；
- 增删不能只靠红绿：同时使用 marker、左轨/底色和屏幕阅读标签。

### 5.5 ProcessRow 展开体宽度

当前通用展开体有左侧缩进。file patch 属于高信息密度查看器，应在 ProcessRow 内容区使用专用 full-width body 变体，让 viewer 对齐卡片内容边界；不得全局移除其他 ToolUse 的缩进。

实现可以由 ProcessRow 通过标准 tool name/共享 helper 判断，或由 ToolUse 返回明确的布局 class。不得复制一份 ProcessRow。

### 5.6 Bash 模拟终端信息架构

模拟终端是一个 surface、三个内部区域：

1. **Terminal header**：shell（如 `/bin/zsh`）与状态。running、completed、failed、stopped、timeout、background 必须有本地化文字；completed 可用低权重 success 标识，non-zero exit 使用 error 标识。
2. **Transcript viewport**：命令 prompt 在前，输出在后，中间只用细分隔线。stdout 与 stderr 是不同 stream section；没有输出显示克制的“无输出”，running 尚无输出显示状态占位，不制造空黑块。
3. **Terminal footer**：cwd、duration、PID、exit code。running 时缺失的字段不占空位；失败/停止时保留已知元信息和已有输出。

状态流：

```text
initializing → command available / running → streaming output → terminal
                                                     ├─ completed (exit 0)
                                                     ├─ failed (non-zero / error)
                                                     ├─ stopped / interrupted
                                                     └─ timeout / background handoff
```

外层 ProcessRow 仍是工具状态的第一 owner；terminal header 是展开后的局部确认，不得增加第二个大 success/error banner。

### 5.7 Bash 命令展示

- 原始 `input.command` 始终是数据真值，但本期没有复制按钮；
- 若 `commandActions[]` 存在且至少一项有非空 `command`，正文优先按 action 顺序展示语义命令，外层 `/bin/zsh -lc` 作为弱化的 shell 元信息，不重复进主命令；
- 若没有 `commandActions[]`，使用 quote-aware 的纯函数只在确定安全的顶层 `&&`、`||`、`;`、`|` 后插入**视觉软换行**。软换行不得改变原字符串、不得写回消息、不得拆引号/转义/heredoc/subshell；不确定时原样展示；
- 禁止 `break-all`。默认 `white-space: pre` + 横向滚动；只有安全软换行点可换行，极端无空格 token 由 viewport 横向滚动承接；
- 使用已有 `react-syntax-highlighter` 的 Bash grammar/theme 做渐进高亮；超预算时回退普通 token，不能阻塞首帧。

### 5.8 Bash 输出展示

输出识别按“高置信度优先、无法确认就纯文本”执行：

1. SDK `{ stdout, stderr, interrupted }` wrapper：保留两个 stream，不再拼接 `[stderr]` 字符串；
2. 完整可解析 JSON：pretty-print + JSON highlight；
3. 明确 unified diff：复用 diff token/行级语义；若无法形成可靠 row model，使用 diff syntax highlight，不冒充 FilePatch；
4. ANSI stream：只有真实 fixture 证明 escape code 被完整保留后，才实现安全的 SGR subset renderer；不执行控制序列、不渲染 OSC 8 外链、不允许任意 HTML；
5. 其他：terminal plain text，保留真实换行与空格，不猜编程语言。

stderr 通过独立 label、弱 error 侧轨与可访问文本区分；不得整块高饱和红底。stdout/stderr 到达顺序若现有协议无法提供，则只保证各 stream 内顺序，不伪造跨 stream 的精确交错时间线。

---

## 6. 数据模型与解析优先级

### 6.1 延续现有协议

`FilePatchDisplayDescriptor` 是现有跨 server/renderer 的 compact display 协议，继续作为唯一协议。

禁止：

- 新增第二个 `edit_preview` SSE payload；
- 把完整 `structuredPatch`、old/new file 或大 unified diff 再复制进 `display`；
- 为 Codex/Gemini 各写一套 React renderer；
- renderer import server runtime 实现。

`display` 继续只存小体积 metadata；大正文继续来自 tool input/result，且受现有 SSE/SessionStore spill 规则保护。

### 6.2 运行时派生模型

在 `src/shared/toolDisplay/` 增加纯函数派生层。可以扩展 `filePatch.ts`，也可以拆出无副作用 leaf module `filePatchRows.ts`；不得引入 React、DOM、Node fs 或 renderer/server 专属模块。

建议类型：

```ts
type DiffRowKind = 'context' | 'add' | 'remove' | 'hunk' | 'omission';

interface DiffRow {
  key: string;
  kind: DiffRowKind;
  oldLine?: number;
  newLine?: number;
  marker: '' | '+' | '-';
  text: string;
}

interface FilePatchRenderChange {
  kind: string;
  path?: string;
  movePath?: string;
  language?: string;
  added: number;
  removed: number;
  rows: DiffRow[];
  rawPatch: string;
  lineNumbers: 'exact' | 'relative' | 'unavailable';
}

interface FilePatchRenderModel {
  source: FilePatchSource;
  status?: string;
  replaceAll?: boolean;
  userModified?: boolean;
  summary: FileChangeSummary;
  changes: FilePatchRenderChange[];
}
```

具体命名可随现有风格调整，但职责必须成立：React 接收的不是待手工拆分的 raw string，而是结构化 row model。

### 6.3 权威来源优先级

每个 tool 的正文与统计按以下优先级解析；高优先级成功后不得被低优先级覆盖：

1. builtin / Claude Code 结果中的 SDK `structuredPatch`、`type`、`filePath`、`gitDiff`；
2. Codex tool input 中结构化的 `changes[]` unified diff；多文件只走这条无歧义数组路径；
3. 已持久化 descriptor + 当前可物化 input/result；
4. builtin Edit 的 `old_string/new_string`；
5. builtin Write 的 `content`；
6. 已知的 Gemini/ACP 结果 diff 文本；
7. 原始结果 fallback。

说明：descriptor 是 metadata 权威，但不是正文来源。若历史消息只有 descriptor 而正文已经被裁剪，应诚实显示“变更详情不可用”，不能生成空的成功 diff。

### 6.4 行号精度

- SDK `structuredPatch` 和合法 unified hunk 提供 exact 行号；
- 只有 old/new 片段而不知道其在文件中的位置时，行号列留空，或仅在明确标注“片段内行号”后使用 relative；
- Write create 可从 1 开始生成新行号；
- Write update 若只有 content input 而没有 originalFile/structuredPatch，不得伪装成 `+N/−0` 的精确文件 diff。外层显示“写入 N 行”，展开体显示目标内容并标注“结果未提供旧版本”；
- 无法解析的 hunk 不得以错误统计覆盖已有 server descriptor。

### 6.5 Write 语义

若 SDK result 提供 `type`：

- `create` → 新建，`+N`；
- `update` → 修改，统计来自 structuredPatch/gitDiff；
- `userModified: true` → 显示非阻断提示“结果由用户在审批时调整”，沿用 SDK 真值；
- `replaceAll: true` → 显示“替换全部”，使用 i18n 文案，不显示英文裸 badge。

若只有 input content：显示“写入 N 行”，不声称是 Git 意义上的新增 N 行。

### 6.6 Codex fileChange 生命周期边界

Codex 0.144.1 的真实生命周期包含三类信息：

1. `item/started` 的 `ThreadItem.fileChange.changes[]`：当前 proposal snapshot；MyAgents 已将其放入 `Edit.input.changes`。
2. `item/fileChange/patchUpdated`：新的完整 `changes[]` snapshot；生成协议明确存在。旧 `item/fileChange/outputDelta` 已标记 deprecated 且“server no longer emits”。当前 adapter 仍只处理旧 delta，未消费新 snapshot。
3. `item/completed` 的最终 `changes[]`：MyAgents 当前通过 `buildCodexFileChangeResultContent()` 把它格式化成人类可读 result 文本。

该 completed 文本不是无歧义机器协议：diff 正文中也可能出现空行以及 `add:` / `update:` 字样。本期明确**不解析该文本来重建多文件边界**，也不为了多文件 viewer 新增大正文协议或复制正文到 metadata。

首期多文件增强只消费当前已经持久化在 tool input 中的结构化 `changes[]`，按数组顺序纵向展示。真实 Session 已证明这条路径可覆盖 4-file change。若实现期间发现 `patchUpdated` 会让 start input 与 completed 最终结果产生用户可见偏差，且无法在现有 compact descriptor 内正确消除，则按用户决策关闭多文件结构化增强、回退 raw result；不得上线一个会静默展示旧 patch 的版本。

本期不增加 live `patchUpdated` 的 renderer snapshot 替换协议。未来若要实时刷新审批中的 patch，必须设计“整份 tool input snapshot replace”语义；禁止把 JSON snapshot 伪装成 `tool_input_delta` 追加，因为当前 accumulator 会拼出非法 JSON。

### 6.7 Bash 静态 transcript view model

在 renderer 或 `src/shared/toolDisplay/` 的纯函数 leaf module 中派生 Bash view model；不得把识别逻辑散落在 JSX 条件中：

```ts
interface BashTranscriptModel {
  shell?: string;
  command: {
    raw: string;
    displaySegments: Array<{ text: string; breakAfter?: boolean }>;
    source: 'command-actions' | 'safe-format' | 'raw';
  };
  streams: Array<{
    kind: 'stdout' | 'stderr' | 'combined';
    format: 'json' | 'diff' | 'ansi' | 'plain';
    text: string;
  }>;
  status: 'initializing' | 'running' | 'completed' | 'failed' | 'stopped' | 'timeout' | 'background';
  meta: { cwd?: string; durationMs?: number; processId?: string; exitCode?: number };
}
```

类型名可调整，但必须保持：原始命令与视觉分段分离；stdout/stderr 不提前拼成一个字符串；format detector 是纯函数、可测试、fail-closed；React 只消费模型。

---

## 7. 视觉规范

### 7.1 层级

- BlockGroup 仍为 Level 3 工具卡；viewer 不新增外层大阴影；
- viewer surface 使用 `--paper-elevated` / `--paper-inset` / `--line-subtle`；
- toolbar 高度、圆角和按钮密度与现有 Tool 区一致；
- 不复制 Codex Desktop 的纯白 IDE 皮肤，也不把 CLI 黑底直接移植为默认。

### 7.2 字体

- 工具 chrome：`text-sm`；
- 次要元信息、行号、marker：`text-xs`；
- 代码：`text-sm` + `--font-code`；
- 不新增任意 px 字号，不使用已删除字阶。

### 7.3 色彩

- add：`--success` 作为 marker/细轨，wash 由 success 与 paper 混合；
- remove：`--error` 作为 marker/细轨，wash 由 error 与 paper 混合；
- hunk：`--paper-elevated` + `--ink-muted`，作为低权重定位元数据，不使用 accent wash 抢占代码注意力；
- code token：沿用 syntax token，不整行变红/绿；
- context：正常 paper/ink；
- dark theme 使用现有 dark token，不硬编码第二套组件颜色。
- Bash terminal surface 使用现有 `--code-bg` / `--code-header-bg` / `--code-text` / `--code-line-number` 与 syntax theme；产品代码不得复制 playground 的硬编码终端颜色。

### 7.4 动效

- 展开/收起沿用 ProcessRow；
- 多文件组按协议顺序静态排布，不做 stagger 或逐卡进入动画；
- “展示全部”只做 150–200ms opacity/height 过渡；
- Bash 状态切换只更新 header/footer 与 transcript 内容，不做终端整体闪烁或高度跳变；
- `prefers-reduced-motion` 下取消非必要动画。

---

## 8. 状态与降级

| 状态 | 展示要求 |
|---|---|
| input streaming | 外层仍显示 running；路径可确定后显示文件名；不要用半截 JSON 生成错误 diff/统计 |
| running, input complete | 可显示输入侧预览，明确状态仍在执行；结果到达后以更高权威来源替换 |
| completed | 显示结构化 patch；无额外 success 大徽章，外层状态已表达 |
| failed / declined / stopped | 外层状态为主；展开体保留已知 input preview，并在 toolbar 给出克制的本地化状态说明 |
| no-op | 显示“没有文本变更”，统计为 0，不渲染空 diff 表 |
| unparseable result | 使用现有 `ExpandableResult` raw fallback，标题明确“原始工具结果”；不得白屏 |
| restored history | 只依赖持久消息已有字段恢复；不得新增第二历史源 |
| Codex multi-change | 结构化 `changes.length > 1` 时按协议顺序纵向分组；无法可靠结构化则 raw fallback |
| move/delete | 文件栏明确动作；move 同时显示源/目标，delete 使用旧行号与 remove rows |
| very long line | 不折行，横向滚动；视觉截断不得改写源数据 |
| missing path | 显示“未命名文件”，禁用路径动作，不显示伪路径 |
| Bash initializing | 单一 terminal skeleton；命令尚不可用时不显示空 prompt |
| Bash running | header 显示“运行中”；命令可读，输出区可流式追加或显示等待状态 |
| Bash completed / exit 0 | header 显示“已完成”；footer 显示已知 duration/PID/exit 0 |
| Bash non-zero / error | header 显示“失败”；保留 stdout/stderr 和 exit code，不用整块红底 |
| Bash stopped / interrupted | header 显示“已停止”；保留已产生内容；`interrupted` 不冒充 failed |
| Bash timeout | header 显示“超时”；若只有错误文本则放在 stderr/error stream |
| Bash background | header 显示“后台运行”；只展示当前协议可见的命令、状态和结果，不制造实时 PTY 假象 |
| Bash no output | 显示“无输出”，不保留一大块空 terminal body |
| Bash unparseable | combined plain text fallback；绝不白屏或丢原文 |

---

## 9. 长内容与性能预算

Chat 页面自身已有大量消息虚拟化压力，文件 viewer 不得一次创建无限 DOM。

首期初始参数（实现前用 fixture benchmark 校准，不把数字视为永久产品真理）：

- viewport 默认最大高度沿用现有约 384px 级别；
- 单文件组初始最多挂载 400 个 diff rows；
- “展示全部”展示该文件组当前消息中已经持有的剩余 rows；若为保证帧预算仍需分批挂载，应在一次用户动作后渐进完成，不再要求用户反复点击“继续显示”；
- 单工具初始总挂载量应受预算约束；多文件按顺序为每组物化初始窗口，不能因纵向布局一次创建无限 DOM；
- 超过 benchmark 证明的安全上限时明确显示“仅展示前 N 行”，并通过现有“更多 → 预览”打开当前文件；删除文件或不存在的目标不得提供无效预览；
- 单行超过安全阈值时可做视觉截断并标明“该行过长”，但不得承诺本期提供完整复制；
- syntax highlight 在正文超过 100KB 或 1,000 rows 时自动回退纯文本；
- Bash transcript 默认最大高度沿用同级工具预算；“展示全部”展开当前持有的剩余输出，超硬上限时诚实标明截断；
- Bash JSON pretty-print、diff detection、ANSI parsing 与 shell formatting 均必须在线性时间内完成并可 memo；高亮超过预算回退 plain text；
- parsing 必须是 pure + memoizable；相同 tool identity/input/result 不重复解析每次 render；
- `display` 只保存 metadata，不复制正文，继续遵守 256KB SSE/IPC 红线。

如果现有 Chat 虚拟列表会在展开后错误估高/估低，修复应发生在现有测量/ResizeObserver 路径，禁止为 FilePatchTool 引入第二套滚动容器 owner。

---

## 10. 交互与无障碍

- ProcessRow header 仍是唯一展开按钮，具有正确 `aria-expanded`；
- 多文件组使用语义化 section/heading；“展示全部”和“更多”可用 Tab 聚焦，并支持 Enter/Space；
- toolbar 图标按钮必须有本地化 `aria-label` 和 tooltip；
- add/remove 行提供可读的隐藏标签（“新增第 37 行”“删除第 36 行”）；
- marker 与行号可见，确保色觉缺陷用户不依赖红绿；
- diff viewport 可键盘聚焦并横向滚动；
- 文件打开继续复用现有 `FilePath` / `FileActionContext` 或正式文件预览入口；
- 任何新增 overlay 必须使用 `useCloseLayer` 与 `OverlayBackdrop`。首期原则上不需要 overlay。

---

## 11. i18n

所有用户可见文案进入现有 zh-CN / en-US 资源。至少覆盖：

- 新建 / 修改 / 删除 / 移动 / 写入；
- 修改前 / 修改后（仅为未来 B 保留时再加入，首期无需死代码）；
- 替换全部；
- 用户调整了工具结果；
- 展示全部 / 收起；
- 还有 N 行未显示；
- 仅展示前 N 行；
- 更多文件操作；
- 没有文本变更；
- 变更详情不可用；
- 原始工具结果；
- 结果未提供旧版本；
- 未命名文件。
- Bash：初始化中 / 运行中 / 已完成 / 失败 / 已停止 / 已中断 / 已超时 / 后台运行；
- Bash：命令 / 标准输出 / 错误输出 / 无输出 / 原始输出；
- Bash：JSON / Diff / Terminal text（若格式标签在 UI 中可见，应本地化或使用通用技术名）。

不得在产品组件中直接写 `replace all`、`update` 等英文状态。

---

## 12. 建议实现切片

### Phase 1：共享解析真相

修改/新增：

- `src/shared/toolDisplay/filePatch.ts`
- 可选 `src/shared/toolDisplay/filePatchRows.ts`
- 对应 `*.test.ts`

交付：

- 解析 SDK structuredPatch / Write type；
- 解析 Codex unified diff 为 `DiffRow[]`；
- 只从结构化 `input.changes[]` 物化 Codex 多文件，不解析 `buildCodexFileChangeResultContent()` 的歧义文本；
- 为 old/new/content 提供诚实的行号精度；
- 统一 summary，修正 Write update 语义；
- 保持 descriptor v1 兼容旧消息。只有确实需要新 metadata 且无法向后兼容时才讨论 v2，不得自行 bump。

### Phase 2：FilePatch viewer

修改/新增：

- `src/renderer/components/tools/FilePatchTool.tsx`
- 建议拆分 `FilePatchViewer.tsx`、`FilePatchToolbar.tsx`、`DiffRows.tsx`，每个组件保持单一职责；
- `src/renderer/components/tools/utils.tsx` 只在可复用 helper 确有归属时调整；
- zh-CN / en-US 文案资源。

交付方案 A 的单文件、Write、状态、raw fallback，以及右上角唯一“更多”动作。“更多”必须复用 `FileActionContext`；若需要抽 helper，应同步让现有 `FilePath` 使用同一 helper，不能复制路径解析与菜单逻辑。

### Phase 3：多文件纵向分组与长内容

- 按 `changes[]` 顺序纵向渲染文件组；
- 去掉顶部裸路径列表和组内重复路径；
- 每组独立 row budget 与“展示全部”；
- 每组“更多”与 FileActionContext 当前文件动作联动；
- ProcessRow file patch 专用 full-width body；
- 窄屏和 dark theme 收口。

如果结构化 input 与最终 applied patch 的一致性无法通过 fixture/真实事件证明，Phase 3 的多文件增强退出本期，不阻塞单文件与 Bash。

### Phase 4：Bash 单一模拟终端

修改/新增：

- `src/renderer/components/tools/BashTool.tsx`
- 建议拆分 `BashTerminal.tsx`、`ShellCommandView.tsx`、`TerminalOutputView.tsx`
- 可选 shared/renderer leaf model 与 detector 单测
- zh-CN / en-US 文案资源

交付：

- 一个 terminal surface 内的 header / transcript / footer；
- commandActions 优先、quote-aware safe formatting、raw fallback；
- stdout/stderr 分流、JSON/diff/plain 渐进增强；
- initializing/running/completed/failed/stopped/timeout/background/no-output 全状态；
- 长结果“展示全部”、明暗主题、窄屏和 reduced-motion；
- ANSI 只有真实 fixture 通过才交付，否则明确回退 plain text，不阻塞本期。

### Phase 5：Runtime 验证与兼容

用真实或 fixture 事件验证：

- builtin SDK Edit / Write create / Write update；
- Claude Code Edit / Write；
- Codex 单文件和多文件 fileChange；
- Codex 多文件 input `changes[]` 与 applied result 一致；不一致且无法正确修复时关闭多文件增强；
- Gemini write_file / replace；
- Bash builtin JSON wrapper 与 external Runtime plain result；
- Bash Codex commandActions、多 stream、non-zero exit、stopped/timeout/background；
- restored session；
- failed / declined / stopped。

若 Claude Code/Gemini 只能提供扁平文本，解析器可以增加明确、受测试的兼容分支；不得在 Runtime adapter 中生成 React 专属数据。Builtin + Codex 是结构化强验收，Claude Code/Gemini 数据不足时诚实回退，不阻塞整体发布。

---

## 13. 测试要求

### 13.1 shared unit tests

至少覆盖：

- structuredPatch 单 hunk/多 hunk行号；
- Codex unified diff：add/update/delete/move、多文件；
- Codex 只用结构化 `changes[]` 区分多文件；completed result 中出现伪 `add:`/`update:` 不触发文本分割；
- header 中 `---`/`+++` 不计入统计；
- old/new 不伪造绝对行号；
- Write create 与 update 语义；
- content 只有尾换行时行数正确；
- replace_all、userModified、status；
- Gemini 已知扁平 diff；
- malformed JSON、partial input、空 patch、未知 kind；
- descriptor-only 历史消息；
- 大文本预算不会改写原始模型内容；
- shell formatter：顶层 `&&` / `||` / `;` / pipe 安全换行，引号、转义、subshell、heredoc 内不误拆；
- commandActions 优先于 raw wrapper，空/未知 action 回退 raw；
- Bash result JSON wrapper stdout/stderr 分流，plain result 保真；
- JSON/diff/plain detector fail-closed；恶意/不完整 ANSI 不执行控制序列、不产生 HTML 注入；
- Bash 状态从 tool loading/result/resultMeta 正确派生。

### 13.2 DOM tests

至少覆盖：

- 外层和展开体不会重复显示工具名/完整路径/总统计；
- old line / new line / marker / code 是独立列；
- add/remove 不是只靠颜色；
- Write input-only 显示“写入 N 行”而不是伪 `+N`；
- multi-file 按输入顺序纵向渲染，每个文件只出现一个 header + body；
- 不存在 file tab、顶部裸路径列表和组内重复完整路径；
- 右上角只有“更多”，不存在独立复制或打开按钮；
- “更多”调用现有 FileActionContext 菜单，并遵守预览/目录树 action 的条件显示；
- 400 行初始预算与“展示全部”；
- failed/raw fallback 不白屏；
- full-width 只影响 file patch，不影响 Bash/Grep/Task 等工具；
- 折叠后大 body 卸载或停止参与布局；
- 明暗主题 class 不产生硬编码颜色依赖。
- Bash 始终只有一个 terminal surface，不出现独立 input/output 大卡片；
- Bash running/completed/failed/stopped/timeout/background/no-output 使用同一骨架；
- stdout/stderr 有独立可访问标签，stderr 不只靠颜色；
- command semantic line breaks 不改变底层原始命令，也不注入伪控制字符；
- JSON/diff 高亮超过预算回退 plain，terminal 仍可读；
- 320px 下页面不横向溢出，terminal 自身可横向滚动。

### 13.3 回归命令

```bash
npm run test:unit
npm run test:dom
npm run typecheck
npm run lint
```

实现若改 server/runtime 归一层，再补跑对应 integration pool。不得为了让测试通过改 classification。

---

## 14. 验收标准

### AC-1：单文件 Edit

给定含两个 hunk 的 Edit，展开后：

- 外层只显示一次 Edit、文件摘要和总统计；
- 展开体显示 basename、相对目录、文件统计和动作；
- 旧/新行号、marker、code 四列对齐；
- hunk 定位使用自然语言，不出现裸 `@@ -a,b +c,d @@`；
- 长行不折行，可横向滚动；
- add/remove 同时有 marker 和非纯色彩提示。

### AC-2：Write create/update

- create 结果显示“新建”与准确新行数；
- update 结果在 structuredPatch 可用时显示真实增删；
- 只有 content input 时显示“写入 N 行 / 结果未提供旧版本”，不虚构删除数。

### AC-3：Codex 多文件变更

以用户提供的真实 Session 中一次修改 4 个文件为例：

- 外层显示“4 个文件”和总统计 `+76 / −21`；
- 展开体按 `changes[]` 顺序从上到下显示 `index.html`、`account.ts`、`analytics.ts`、`main.ts` 四个文件组；
- 每个组只显示一次 basename/相对路径、operation、统计、正文和“更多”；
- 四个文件分别处于独立卡片中，卡片之间有清晰留白，不共享连续边框或 `divide-y` 外壳；
- 不出现顶部裸路径列表、file tab 或组内重复完整路径；
- 每组“更多”只操作本组文件；
- 不产生 `Multi-file` / `MultiEdit` 新 tool name。
- 若 fixture 证明 input snapshot 不是最终 applied patch 且无法正确消除偏差，则本期回退 raw result，不上线错误的结构化多文件 viewer。

### AC-4：长 patch

2,500 行 patch：

- 初始 DOM 不超过 400 个 diff rows；
- 用户点击一次“展示全部”后展示当前消息可安全物化的剩余内容；
- UI 明确还有内容未内联显示；
- Chat 滚动和折叠交互无明显冻结。

### AC-5：Runtime 一致性

对等语义的 builtin、Claude Code、Codex、Gemini fixture 在 UI 中使用相同 viewer，不出现 Runtime 专属皮肤；Builtin + Codex 通过结构化强验收，Claude Code/Gemini 数据不足时诚实降级，不造假行号/统计，也不阻塞整体发布。

### AC-6：恢复与失败

- REST 恢复的历史消息仍能展示；
- 只有旧 descriptor 时不崩溃；
- declined/failed/stopped 保留输入预览并显示状态；
- unparseable result 有 raw fallback。

### AC-7：设计系统

- 浅色/深色均使用现有 token；
- 字阶只使用 DESIGN.md 七档；
- 默认方案没有突兀黑底；
- 768px Chat 列和 320px 最小窗口无页面级横向溢出；diff 自身横向滚动是允许且必要的。

### AC-8：Bash 单一模拟终端

- 展开体只有一个 terminal surface，内部依次呈现 header、command、stdout/stderr、footer；
- Codex 有 `commandActions[]` 时主命令不再显示冗余 `/bin/zsh -lc` 包装；无 action 时只在安全 shell 边界软换行；
- 不再使用 `break-all`，路径、参数和 quoted string 不在任意字符处断裂；
- initializing、running、completed、non-zero exit、stopped/interrupted、timeout、background、no-output 都在同一骨架中有明确状态；
- stdout/stderr 分区，JSON 和 unified diff 在高置信度下高亮，普通日志保持 plain terminal text；
- 没有新增复制命令或复制输出动作；
- 明亮/暗夜主题、320px/768px、键盘 focus、文本选择、长行横滚与 reduced-motion 均通过视觉 QA。

---

## 15. 关键设计决策

### D1：改展开体，不改消息架构

原因：Message/BlockGroup/ProcessRow 已正确表达过程流。问题发生在 file patch 内容如何物化和呈现，另建消息类型会制造第二 owner。

### D2：方案 A 是产品默认

原因：它保留 Codex 产品的结构清晰度，但不复制其材质；在 MyAgents 主场景 768px Chat 中比双栏更稳定，比黑底更克制。A 随系统主题提供明亮/暗夜两套 token 表现，C 始终只是另一种高对比视觉方向。

### D3：结构化 row model 位于 shared

原因：统计、路径、行号必须由 outer summary 和 inner viewer 共享同一真相；否则 Runtime 兼容和恢复消息会继续漂移。

### D4：不把完整 patch 写进 display descriptor

原因：大 payload 已有 256KB SSE/IPC 红线；重复存正文会增加 SessionStore、SSE 与 renderer 内存压力。descriptor 只负责小 metadata。

### D5：无行号胜过假行号

原因：old/new snippet input 没有绝对位置。审阅 UI 的可信度高于表面完整度。

### D6：Write input-only 不等于新增

原因：Write 可覆盖既有文件。只有 SDK output `type`/structuredPatch 才能判断 create/update 和真实增删。

### D7：Chat 内受预算显示；用户动作统一叫“展示全部”

原因：viewer 是工具过程的二级信息，不是代码审阅主页面。用户不需要理解“上下文”和“继续显示 N 行”的实现差别；有剩余内容时统一提供一次“展示全部”。实现仍要通过渐进物化与 hard cap 保护帧预算，超过安全上限时诚实说明，而不是用按钮文案掩盖截断。

### D8：Codex 多文件按顺序纵向分组，不发明新工具类型

原因：Codex 0.144.1 正式协议、MyAgents adapter、测试、生产日志以及用户提供的 4-file Session 都证明单个 `fileChange` 会携带有序 `changes[]`。用户确认从上到下阅读即可；纵向分组没有 tab 状态，能保留协议顺序和改动全貌。正确做法是每个 change 一组、消除重复路径和重复 chrome，而不是新增 `Multi-file`、激活遗留 `MultiEdit` 或把多个 Anthropic Edit 人工合并。

### D9：多文件增强 fail closed

原因：completed result 的人类可读字符串不是可靠分隔协议。本期只消费结构化 `changes[]`；如果无法证明它与最终 applied patch 一致，就先不做多文件增强。宁可回退原始结果，也不能展示看似精美但可能过期或错分的 patch。

### D10：文件栏只保留“更多”，去掉本期所有专用复制能力

原因：完整复制会被 renderer 截断、large-value ref TTL 和历史恢复边界破坏，继续承诺会产生静默不完整结果。用户决定直接移除“复制当前变更/内容/命令/输出”功能。文件路径既有动作仍由 `FileActionContext` 的“更多”菜单拥有，菜单中的既有“复制路径”不受影响。

### D11：Bash 使用单一模拟终端，不做两块输入/输出卡片

原因：命令、stdout/stderr、cwd、PID、耗时、exit code 和状态共同描述一次执行。把它们放进一个连续 surface，用户才能从上到下理解发生了什么；它是静态 transcript，不是 PTY，也不应该引入 xterm 生命周期和额外 owner。

### D12：Bash 高亮渐进增强，识别失败就 plain text

原因：shell command、JSON、unified diff 有明确 grammar，可以高置信度增强；普通命令输出可能是日志、表格、源码或混合文本。错误上色比不上色更干扰阅读，所以 detector 必须 fail closed，ANSI 也只有真实 fixture 证明保真后才实现安全 subset。

### D13：Runtime 采用结构化强验收 + 诚实回退

原因：Builtin + Codex 当前有足够结构化数据，必须达到完整体验；Claude Code/Gemini 能提供可靠数据时进入同一 viewer，数据不足时使用 raw/plain fallback，不用 Runtime 专属皮肤，也不阻塞本期发布。

---

## 16. 实现前必须实证的问题

这些问题不阻塞 PRD 定义；Builtin + Codex 主路径阻塞对应实现合并，Claude Code/Gemini/ANSI 失败则按既定降级边界退出对应增强：

1. builtin 与 Claude Code 在当前 `0.3.201` SDK / external adapter 下，Edit/Write 的 `tool_use_result` 是否都稳定包含本文列出的 output 字段；其 JSON.stringify 结果在 live SSE 与 REST 历史恢复中是否一致。
2. 当前 Gemini ACP 对 `write_file` / `replace` 的 completion content 实际形态：是否能获得 hunk 行号、旧/新文本、目标路径；若只有扁平 diff，fixture 必须来自真实事件，不得凭猜测写 parser。
3. Codex `item/started` 的 `changes[]` 是否在当前版本始终等同最终 applied patch。至少固定用户 Session 中 2-file 与 4-file 真实去敏 fixture，并覆盖存在 `patchUpdated` 的样本；若不能证明一致且不扩协议就无法修正，多文件增强按 D9 退出。
4. Bash 在 builtin、Claude Code、Codex、Gemini 中的 stdout/stderr、interrupted/timeout/background、ANSI escape code 是否保真。没有真实 ANSI fixture时不实现 ANSI renderer，使用 plain text fallback。

实证方式：读取 SDK 类型与 adapter 源码、抓一组去敏真实事件、固定成测试 fixture。不得调用真实 Provider 才能跑的测试放进默认 CI。

---

## 17. 发布与观测

- 作为现有 FilePatchTool 与 BashTool 的直接升级，无需 feature flag；
- 合并前用一组旧 session fixture 验证向后兼容；
- 重点观察 renderer 长任务、Chat scroll jank、FilePatch raw fallback 比例、Bash plain fallback 比例与 terminal 展开高度；
- 若 analytics 已有 tool render 事件，只能追加低基数字段如 `view=structured|raw`、`source=builtin|codex|external|unknown`，不得记录路径、代码或 diff 内容；
- 不因视觉升级改变工具成功/失败口径。

---

## 18. 交付物

本需求在设计阶段已产生：

- PRD：`specs/prd/prd_0.3.1_file-edit-tool-preview.md`
- 独立 playground：`specs/playground/file-edit-tool-preview.html`

开发完成后还应包含：

- shared parser / render model 与单测；
- 方案 A 的生产 React 组件；
- Bash 单一模拟终端生产组件与 transcript model；
- zh-CN / en-US 文案；
- DOM 回归测试；
- builtin / Claude Code / Codex / Gemini fixture 验证记录；
- macOS WKWebView + Windows WebView2 的明暗主题视觉 QA 记录：768px / 320px、100% / 125% / 150% 缩放、长行横滚、键盘 focus/selection、菜单裁切与系统滚动条差异。

---

## 执行台账

### 总体契约（2026-07-15）

- **分支 / 起始基线**：`dev/0.3.1` / `b11d2548ce5593d90bd9dc374fe9ceb3b23c85ea`。
- **必须赢的结果**：Edit / Write 使用同一份纯数据解析真相生成可信 diff row；Codex 单个 `Edit.input.changes[]` 按协议顺序纵向展示；文件 viewer 只保留“更多”文件动作；Bash 以一个只读模拟终端连贯展示 command、stdout/stderr、状态和 footer；所有专用复制动作缺席。
- **延续的 owner / 抽象**：`ToolUseSimple`、`FilePatchDisplayDescriptor v1`、`buildFilePatchDisplayDescriptor()`、`resolveFilePatchDisplay()`、`ProcessRow`、`ToolUse`、`FileActionContext`、`ExpandableContainer`、既有 i18n 与设计 token。不得新增 tool name、SSE 事件、持久化正文副本、工作区 IO 路径或第二套工具 chrome。
- **允许新增的最小概念**：`DiffRow` / `FilePatchRenderModel`（shared pure projection）和 Bash transcript view model（renderer leaf pure projection）。二者只解释已到达 renderer 的数据，不拥有 Runtime、进程或文件系统状态。
- **反向边界**：不从 Codex completed 人类可读文本切分多文件；不伪造 old/new snippet 的绝对行号；不把 input-only Write 宣称为 create；不实现 ANSI（除非真实 fixture 证明保真）；不复用 xterm / PTY；不新增复制；不触碰本工作树中既有的 MCP readiness、queue、session 或架构文档改动。
- **验证总则**：每个 Phase 先跑 scoped unit / DOM / typecheck，再执行 fresh-context requirements、adversarial、architecture 三镜 review；三镜全部通过且整改清零后，只显式提交本 PRD 范围文件。最终再跑 `test:unit`、`test:dom`、`typecheck`、`lint` 与相关 build / fixture smoke。

### Phase 1：共享解析真相

- **phase base**：`b11d2548ce5593d90bd9dc374fe9ceb3b23c85ea`。
- **范围**：`src/shared/toolDisplay/filePatch.ts`、对应 unit tests，以及消费同一 render model 的 `toolBadgeConfig.tsx` / EditTool DOM 回归 / Write 摘要中英文本地化。外层摘要必须与 canonical model 同源，避免在 viewer 上线前继续制造 input-only Write 的假 `+N`。
- **契约**：消费 SDK `structuredPatch` / Write `type` / `userModified`；把可信 unified diff 与 SDK hunk 转成四列 row model；old/new/content 只给相对 snippet 行号或空行号；保持 descriptor v1 且不复制正文；summary 与 rows 同源；多文件只来自结构化 `changes[]` 并保序。
- **反例护栏**：header `---/+++` 不计统计；malformed/partial/descriptor-only 不崩；completed result 中伪造的 `add:`/`update:` 不影响文件边界；大文本 budget 只裁展示投影，不改原始 tool 内容。
- **验证进度**：最新定向 33 个 shared unit、5 个 i18n parity unit、8 个 Edit/Write DOM、typecheck、scoped ESLint 已通过；完整 unit 为 281 files / 2534 pass / 3 skip，完整 DOM 为 93 files / 463 pass。第一次三镜 review 阻断了 unified hunk 计数、Gemini provenance、descriptor 权威与 partial multi-file；第二次复验继续阻断了 add/delete hunk-like 正文、stale parsedInput、SDK incomplete lookalike、stale `written` metadata 与单复数文案；最后 adversarial 复验拦住了“相等内容 + 损坏 git patch”被误判 no-op。上述问题均已按 raw-input authority / complete SDK schema / fail-closed 原则整改；requirements、adversarial、architecture 三镜最终均 PASS。
- **状态**：已完成并提交：`c314e55c`（`feat(chat): normalize file patch render model`）。

### Phase 2：FilePatch viewer

- **phase base**：`c314e55c`。
- **范围 / 契约**：方案 A 单文件 viewer、四列 diff、可信 Write/status/raw fallback、i18n、每文件右上角唯一“更多”动作；复用 FileActionContext，不复制菜单或路径解析。
- **实现进度**：`FilePatchTool` 已改为暖纸方案 A：文件名与短父路径唯一 header、操作/统计、旧行号/新行号/marker/code 四列、低饱和增删 wash、横向滚动、键盘 focus、语法 token、Write 旧版本未知提示、状态/replace-all/userModified notice 与 raw fallback。文件右上角只新增一个 ellipsis 入口，并与现有 `FilePath` 共用同一 `resolveFileActionTarget → checkFileTarget → FileActionContext` helper；菜单内容仍由既有 owner 提供，未复制菜单，也未新增任何专用复制动作。
- **验证进度**：定向 DOM 20 项（Edit / Write / 四列 selection / FileAction 集成唯一动作与 declined move）与 i18n parity 5 项通过，`typecheck`、scoped ESLint 零 warning；完整 unit 282 files / 2542 pass / 3 skip，完整 DOM 93 files / 466 pass。三镜 review 先后阻断了 marker / hunk / omission / 隐藏朗读文本进入复制选择、缺少 toolbar 集成契约、空内容 Write 被误写成 no-op、跨工具 heading id 冲突、本地 syntax token / 文件语言映射重复真相，以及 declined/running move 错把尚未落地的目标当成文件动作对象；均已按 select-none、诚实空目标、`useId()`、既有 `codeBlockSyntaxTheme` / `getPrismLanguage()` owner 与 completion-aware action target 整改。应用内 Browser 当前无可用实例，真实浅/暗/窄宽视觉 QA 按发布门禁保留，不能伪报通过。
- **状态**：实现与三镜 review 已完成（requirements / adversarial / architecture 均 PASS），已提交：`7e019464`（`feat(chat): redesign file patch preview`）。

### Phase 3：多文件与长内容

- **phase base**：`7e019464`。
- **范围 / 契约**：按 `changes[]` 保序纵向分组、每文件一次 header/body/action、独立 400-row 初始预算与单次“展示全部”、full-width 只作用 file patch、窄屏 / dark 收口。
- **实现进度**：多文件按用户 2026-07-16 裁决改为独立紧凑卡片纵向排列，文件卡之间使用 12px section gap，不再共享 outer surface / `divide-y`；协议顺序不变，重复 basename 计算最短可辨识父路径。hunk 的结构化 old/new 起始行与范围长度进入 render model，UI 转译为自然语言定位信息，不展示裸 `@@` 协议文本；无法可靠解释时隐藏。单文件上限 400 rows、单工具初始总量同样限制为 400 并在多文件间公平分配；视口约 384px，按文件一次“展示全部”，其它组状态不变；单文件 hard cap 5,000 rows，超限诚实提示，syntax highlight 在 1,000 rows / 100KB 后回退 plain。ProcessRow 仅对 Edit/Write 去掉既有 `ml-7`，其它 tool 保持缩进；文件 header 在窄宽换行，diff 只在自身横向滚动，全部颜色继续使用明暗主题 token。
- **验证进度**：定向 DOM 31 项（FilePatch / FileAction / ProcessRow）与 i18n parity 5 项通过，`typecheck`、scoped ESLint 通过；完整 DOM pool 通过。覆盖多文件顺序、400 总初始 DOM、独立 show-all、重复 basename、syntax fallback、5,000-row hard cap、responsive class、file-only full width 与 `aria-expanded`。三镜 review 发现零预算文件组的展开入口、重名文件 viewport / show-all 可访问名称，以及 hard-cap 状态与 viewport 的朗读关联不完整；均已用 reachable min-height、最短可辨识 accessible name、file/count aria-label 与 `role=status + aria-describedby` 修复。应用内 Browser 仍无可用实例，因此 320px / 768px 的 macOS WKWebView 与 Windows WebView2 实机视觉矩阵仍是发布门禁，不伪报完成。
- **状态**：已完成并提交：`18a97492`（`feat(chat): refine multi-file patch layout`）。

### Phase 4：Bash 单一模拟终端

- **phase base**：`18a97492`。
- **范围 / 契约**：单一 terminal surface；`commandActions[]` 优先、quote-aware 安全折行、raw fallback；stdout/stderr 分区；JSON/diff/plain fail-closed；完整状态、长内容、i18n、无复制。
- **实现进度**：新增 renderer pure leaf `bashTranscript.ts`，把 untouched raw command、presentation-only line breaks、ordered `commandActions[]`、stdout/stderr stream、format 与状态统一投影成 transcript model。安全 formatter 只在 quote / escape / nesting / comment 之外的可信顶层 operator 后断行，heredoc、nested substitution/comment grammar、case compound operator、`>|` 与不平衡输入 fail closed；JSON 只有 native stringify 能证明不改变原文本真值时才 pretty-print，否则保留原字节并只做 syntax token；diff 必须具备可信 hunk/change 证据，ANSI 因无跨 Runtime 保真 fixture 继续作为 inert plain text。SDK wrapper 必须满足当前 `BashOutput` 必填字段且不得含未知字段，否则作为“原始输出”完整保留；external 聚合结果即使 non-zero 也保持 combined，不伪称 stderr。`BashTool` 已改为一个 token 驱动的 terminal surface，内部连续包含 shell/status header、command、独立 stream、empty/running row 与 cwd/duration/PID/exit footer；无 `break-all`、无专用复制动作，background handoff 无输出时也不伪装成持续等待的 PTY。命令与输出共同进入一份导出的 5,000 行 / 512KB hard cap：`commandActions[]` 在 pure model 内即按同一预算投影，model-level `hasHiddenCommandContent` 不依赖可见 command 存在；raw command 同样区分“预算内有可见字符”和“预算外未知内容”，未知只保留 hidden authority、不画空 `$`。视图再公平分配初始 400 行 / 100KB、一次“展示全部”与 Prism 降级；`ToolUse` 不再在 Bash 专用 owner 之前用 legacy 50/200KB clamp 破坏 stream JSON。所有 known-field selection、detector、wrapper/input JSON parse、shell-wrapper/status scan、action inspection、line count 与截断先受 O(1) field check 或全局 byte/prefix budget 约束，不再枚举超大 structured input，也不为 16MB 输入/结果或 500k actions 执行 full `Object.keys/flatMap/join/trim/JSON.parse/split/regex scan`。旧 external history 的 raw `inputJson` 只对非 object-like shell command 启用；以 `{` 开头的 raw 在 JSON 与 Bash brace grammar 之间没有可靠判据，renderer 明确 fail closed、等待 parsed/structured authority，不再维护半套 JSON+Bash parser。正常 Runtime 的结构化 `input.command` 不受影响，brace command 可完整显示。超过严格 wrapper parse budget 的结果不再从正文猜状态，只信既有 `isStopped` / `isError` / `isFailed` / `resultMeta.status` / `exitCode` 权威字段，避免把业务 JSON 冒充执行状态。若后续需要让超大 builtin wrapper 的中断态完全保真，应在上游归一到既有 `ToolResultMeta.status`，不把协议扫描职责下沉到 UI。
- **验证进度**：pure model 44 项 unit、terminal / ToolUse 24 项 DOM、i18n parity 5 项通过，覆盖 Codex action precedence、quote/subshell/comment/heredoc/compound operator、双引号内 nested command/parameter substitution 与 nested comment fail-closed、stale/partial/object-like raw fail-closed/unambiguous restored raw/structured brace command/oversized input、长空白 prefix 后真实内容与超预算纯空白 hidden-only、structured input 不枚举、5,000-action model hard cap/无可见 command 的 hidden authority/纯空白 action、bounded shell-wrapper detection 及 synthetic EOF lookahead、SDK stdout/stderr/unknown-field/oversize fallback、超大 wrapper 的权威 resultMeta 状态与 external 业务字段不误认、external combined provenance、lossless/bounded JSON/diff/plain、inert ANSI、初始化/运行/完成/失败/停止/中断/超时/后台、background 静态无输出、0ms/metadata、空输出、原始输出、单 surface、无 copy、上游 50KB plain / 200KB JSON clamp 均不破坏 Bash、命令+输出共享预算、multiline action 边界、show-all/hard cap、command/output highlight fallback 与唯一横滚 owner；`typecheck`、scoped ESLint、`git diff --check` 通过。三镜 review 提出的 shell 误拆、nested substitution quote stack/comment、伪 wrapper 丢字段、JSON 数值失真、partial/raw authority、brace/JSON ambiguity、command unbounded Prism/empty prompt、双 truncation owner、footer 第二 scroller、presentation-height 漏算、background PTY 假等待、external stream provenance、pre-window O(full payload)、oversized tail 状态误判/漏判、unbounded input JSON/wrapper regex、synthetic EOF、structured input/action 全量物化与 hidden owner 丢失均已整改；对不可判定的 legacy object-like raw 明确收窄兼容面而非继续扩展 parser。应用内 Browser 无可用实例，真实 WKWebView/WebView2 明暗/窄宽视觉 QA 仍保留为发布门禁。
- **状态**：实现、定向验证与三镜 review 已完成（requirements / adversarial / architecture 均 PASS），已提交：`e8ba0ee1`（`feat(chat): redesign bash tool transcript`）。

### Phase 5：Runtime fixture 与兼容收口

- **phase base**：`e8ba0ee1`。
- **范围 / 契约**：builtin / Codex 结构化强验收，Claude Code / Gemini 诚实回退；真实去敏 fixture 覆盖恢复、失败和 Codex 多文件一致性；若无法证明 snapshot 等于 applied patch，则关闭多文件增强而非猜测。
- **实现进度**：核验真实 Session `2d6ec8dc-7bad-4c6b-a393-2fcdafb5ebff` 的 rollout：单个 `fileChange` 完成态成功应用 4 个文件；input 顺序为 `index.html → account.ts → analytics.ts → main.ts`，`patch_apply_end` 对象顺序不同但按 path 比对 diff 完全一致，总计 `+76/-21`。测试使用独立、去敏的 started input 与 applied snapshot，避免用同一 descriptor 自证。Codex started 事件保持 O(1) 轻量，completed 事件在既有 `tool_use_stop` 上提供最终 input；top-level 复用 `chat:content-block-stop`，nested 复用 `chat:subagent-tool-use` upsert，持久化前同样替换 pending input，没有新增事件名、状态 owner 或 React 专属 Runtime 数据。超过 192KiB 的完成 input 复用 server large-value store，并由 renderer 直接读取既有 CORS `/refs/:id`，避免经过 Tauri IPC 再次缓冲；结果正文仍沿用 256KiB spill，top-level / nested 均保留 stop → result 顺序和 nested `resultMeta.largeValueRef`。结构化 Edit/Write 完成结果即使 spill 后只剩 8KiB 预览，也被视为“完成结果权威但正文不可解析”，诚实显示有界 raw preview，绝不回退到陈旧 input 草案。FilePatch renderer 在纯投影层限制 100 files / 5,000 rows / 512KiB，扫描在预算处停止遍历和切片，同时保留真实总文件数、可计算的完整增删统计与有界提示；Bash safe-format 同样在 5,000 segment 前停止物化但继续 fail-closed 校验，raw command 保持不变。
- **验证进度**：最终定向回归通过：FilePatch shared 31 项、Bash pure model 45 项、Codex protocol 24 项、external content block 4 项、native large-value ref 1 项；Edit / Write / Bash / ToolUse / nested Collab DOM 共 56 项，external mock integration 覆盖 220KiB input 与 300KiB nested result spill。`typecheck`、test classification、scoped ESLint、`git diff --check` 均通过；三镜 requirements / adversarial / architecture 最终均 PASS。完整 DOM pool、web build 与 dependency-cruiser 在前序最终基线通过；完整 unit / 全量 lint 的剩余失败来自工作区内不属于本需求的并发修改，已隔离记录。应用内 Browser 无可用实例，因此真实 macOS WKWebView / Windows WebView2 的明暗、320px / 768px 视觉矩阵仍是发布门禁，不伪报完成。
- **状态**：已完成，随本阶段最终提交交付。
