# Chat 滚动与窗口呈现生命周期

本文定义桌面主窗口失焦、最小化、隐藏、恢复与内部 Tab 切换时，Chat 虚拟列表的 owner、状态来源和恢复不变量。用户可见的 Shell 交互以 `specs/design/app_shell.md` 为准；本文解释实现边界与事故防护。

## 1. 为什么 focus 不是滚动生命周期

桌面 focus 只回答“键盘输入当前交给谁”，不回答窗口是否可绘制。Windows 允许用户在未激活窗口上悬停滚轮；macOS 的分屏、多显示器与 App 切换也可能让失焦窗口继续可见。若 blur 时保存一个不可变滚动快照、focus 时强制恢复，blur 后发生的真实用户滚动就会被旧快照覆盖。

因此：

- `onFocusChanged` 只更新通知/input attention，并触发一次 native surface 采样；focus 布尔值不进入 Chat scroll controller。
- shown 且未 minimized 的 active Chat 始终实时渲染和接收滚动输入。
- 只有不可绘制或几何不可信的 surface 才开启 continuity transaction。

## 2. Owner 与权威状态

| 事实 | Owner / source of truth | 生命周期 |
|------|-------------------------|----------|
| 主窗口是否 shown 且未 minimized | `useTrayEvents` 对 Tauri window 的采样；Rust-owned hide/show 由 canonical tray helper 同步发同一 edge | App 进程内 |
| presentation generation | `App` 的 `reduceMainWindowPresentation()`；available→unavailable 时递增 | App 进程内 |
| 当前 generation 的容器几何是否可用 | `MessageList` 外层 viewport 的非零 `ResizeObserver` | 当前 Chat mount / generation |
| Virtuoso 是否允许消费 live input | `isActive && surfaceAvailable && containerReadyForGeneration` | 当前 Tab commit |
| follow、可信 anchor、恢复事务与结算 | `useChatScrollController` | 当前 Chat / Session |
| messages、SSE、Session 生命周期 | `TabProvider` / Sidecar | 不受窗口呈现影响 |

不得把后端消息进度、document focus、一次端口/尺寸探测或 Virtuoso 的迟到 callback 提升为上述其它事实的 authority。

## 3. Presentation 与 admission 状态机

`MainWindowPresentation` 只有两个字段：

```ts
{ surfaceAvailable: boolean; generation: number }
```

规则：

1. focus、非零 resize、document visibility change 只触发 `isVisible + isMinimized` 最新优先采样。
2. 零尺寸 resize 和 renderer 主动 hide 在 native 操作前立即发布 unavailable，并使更旧的异步采样失效。Rust 全局快捷键等 Rust-owned hide/show 必须经过 `tray::hide_main_window` / `show_main_window`，在 WebView 可能暂停前后通过 `main-window:presentation-changed` 投影同一事实；这不是第二个 generation owner。
3. available→unavailable 推进一次 generation；重复 unavailable 和 unavailable→available 不重复推进。
4. surface 恢复后，MessageList 必须看到当前 generation 的非零容器几何才重新 admission。generation 0 的正常首屏可直接进入；恢复 generation 或首次在恢复 generation 内挂载的 Chat 都必须经过 observer。
5. 非 admitted 状态下 Virtuoso 继续 mounted，但只接收最后一次 admitted snapshot；从未 admitted 的列表接收空 snapshot。不得用 remount / React key 清空其内部状态。

App 的 Tab memo comparator 只让 active Chat 响应 presentation 对象变化；inactive Chat 在重新成为 active 时一次取得最新 generation，避免窗口事件重渲染全部重型 Tab。

## 4. Continuity transaction

`useChatScrollController` 是唯一恢复 owner。

### admission true → false

- 清除旧 layout compensation 与 bottom pin。
- 若 follow 为 `true` / `force`，保存 `follow=true`。
- 若用户正在阅读历史，保存该 Session 最近一次可信的 `{messageId, offsetFromViewportTop}`。可信 anchor 在 admitted viewport 的 scroll / atBottom(false) 上持续更新，因此可见失焦期间的 hover-scroll 自然覆盖旧位置。
- 创建单调 transaction id 并开启 recovery fence。重复 unavailable 信号不覆盖第一次捕获的用户意图。

### admission false → true

- Session identity 已改变：丢弃旧事务，由新 Session 的既有 initial pin owner 接管。
- follow 用户：只调用一次 `scrollToBottom('auto')`，随后关闭 fence。
- 历史阅读用户且目标 row 已挂载：只用 Virtuoso `scrollBy` 修正相对 offset，随后关闭 fence。
- 目标 row 尚未挂载：在 fence 内只调用一次 `scrollToIndex({align:'start'})` 请求挂载；最终 offset 等待 Virtuoso `itemsRendered` 后结算。`align:start` 是内部 mounting step，不是可见最终状态。
- 目标 message 已删除：结束事务，不猜相邻位置。

所有 callback 都核对当前 Session、presentation generation 与 pending transaction identity。发送消息/回到底部、搜索、工具定位，以及 `useVirtuosoScroll` 已识别的 wheel/touch/scrollbar/viewport-key 输入优先级更高，会取消未完成的 continuity transaction。恢复 fence 内禁止普通跟随对齐；恢复后已经到底时不得再次发出滚动命令。

## 5. 不变量与禁止项

Chat 底部 query 耗时由 TabProvider 的 `useQueryElapsedClock` 持有，使用单调时钟累计当前 query 的运行片段；未决权限、AskUserQuestion 或 ExitPlanMode 等待期间暂停。已 resolved 的计划卡及自动批准的 EnterPlanMode 不暂停。Footer 仅每秒采样，工具/文案/布局变化、presentation suspension 和 Chat 展示子树重挂载都不能重置起点。结束、新 query 或真实 Session 切换重置，pending identity 实体化保留。首次中途加入或整个 Tab owner 重建时无法恢复过去的暂停片段，计时从当前观察开始；不改变历史消息 `durationMs` 的后端墙钟含义。

Virtuoso 的 Footer 必须使用模块级稳定组件类型，动态内容通过现有 list context 传入，并与 data 一同遵守 frozen snapshot。`useMemo(() => function Footer(){...}, [动态值])` 仍会在依赖变化时创建新组件类型，重挂载整个 footer，不能作为“稳定 Footer”。

冻结展示 snapshot 不等于暂停组件内部的副作用。`MessageListPresentationContext` 只向 Footer 投影现有 `canLayoutVirtualList` 准入结果，不持有第二份状态；该值不能随 Virtuoso context 一起冻结。Footer 的 `useSyncExternalStore` 仅在准入时每秒订阅 Tab clock，并在不可呈现时撤销轮询、卸载 spinner 的动画节点（保留固定占位）；恢复时立即读取当前 clock。Chromium 可以延迟处理 `content-visibility:hidden` 后代的 class/style 变化，单纯移除动画 class 不保证立即清除已有 CSS animation。否则隐藏前的 loading snapshot 会使计时器在后台任务结束后仍永久运行。Tab clock 本身通过时间差累计，不依赖此轮询，也不因窗口隐藏、暂停采样或恢复而重置。

- focus change 必须产生零个 Chat scroll command。
- 可见失焦窗口的 `atBottomStateChange`、follow 与 pagination 正常工作。
- suspension 期间消息/SSE 正常推进，但 data、firstItemIndex、height estimate 和行测量不进入 Virtuoso。
- restore 期间普通底部对齐、pagination 和迟到 row measurement 不能抢在 continuity transaction 前执行。
- 不直接写 `scrollTop`，不增加平行 DOM scroller，不使用固定 timeout、无限 retry、单 RAF 猜测 WebView readiness，不用 React key/remount 修复缓存。
- internal Tab hide 与 native surface suspension 共用 list admission / continuity owner；不能再在 MessageList 内保存第二份 follow snapshot。

## 6. 连续输出与阅读意图

`useVirtuosoScroll` 持有用户是否跟随最新内容的意图。`atBottomStateChange` 仅描述虚拟列表的几何位置；正文、Footer、提示卡或输入框增高导致离底，不能关闭跟随。上滚 wheel、touch、viewport key 或 scrollbar drag 进入阅读模式；向下输入到达真实底部（1px舍入容差）或显式“回到底部”恢复跟随。输入框内的光标移动不属于 viewport key。

主动展开消息/工具详情也是阅读意图，`onRowLayoutChanged` 在 direct-toggle 分支暂停跟随；不能再依赖展开后的几何离底来推断用户意图。搜索已挂载命中的快速路径也先调用控制器的 `pauseAutoScroll()`，再定位文字范围。

`scrollToMessage()` 返回本次导航是否仍有效的只读判断，供搜索的延迟 Range 定位和工具的延迟细定位共用。控制器的一份 navigation version 只在新输入/导航或生命周期失效时更新；Session、presentation generation 和 admission 也必须仍匹配。它与 continuity transaction 的序号分开，因为自动的行布局补偿不能取代用户导航意图。旧回调不得在用户滚动、切换 Session 或不可呈现之后重新发起滚动。

搜索、工具/Query 定位与 rewind/retry 调用 `pauseAutoScroll()` 后保持阅读模式，直到用户回到底部；不以固定500/2000ms定时器恢复过去的跟随决定。新的阅读输入还通过 Virtuoso 的 `scrollBy({top:0, behavior:'auto'})` 取消进行中的原生平滑滚动。react-virtuoso 4.18.3 原版的 index 定位会在动画停止后继续响应尺寸变化并重试旧目标；`scripts/patch-react-virtuoso.mjs` 在库的 scrollToIndex owner 内让新的 scrollBy 清除旧的测量/动画订阅及超时，两个模块格式一起校验并修复。版本固定为4.18.3，安装时应用，开发/构建/typecheck前验证；升级时必须重跑真实浏览器取消定位回归并评估移除补丁。

MessageList 将 `followOutput` 固定为 `false`，因为 react-virtuoso 4.18.3 的同数量尺寸增长/viewport缩小路径只检查原始prop是否为false，并不会调用function形式的策略。自动跟随由同一 `alignFollowingViewport` 处理：React layout commit、Virtuoso `totalListHeightChanged` 和 scroller resize 都读取当前scrollHeight，通过 Virtuoso `scrollTo` 的像素API对齐；不直接写scrollTop。已到底、阅读中、未admitted或恢复fence内均不发命令。逐token与terminal不再拥有独立pin逻辑。

`scrollToIndex(LAST/end)` 使用缓存的行高，因此仅把命令提前到layout effect不能保证采用当前正文高度；WebKit可能将过渡位置绘制出来。行为验证必须包括真实虚拟列表与WebKit画面，不能把rAF中间读数直接等同于已绘制抖动。AssistantActions在回合结束的同次commit出现，避免loading移除后再延迟350ms插入操作栏。

## 7. 代码入口与验证

- native projection：`src/renderer/hooks/useTrayEvents.ts`、`src-tauri/src/tray.rs`
- pure generation policy：`src/renderer/utils/mainWindowPresentation.ts`
- App / active Tab projection：`src/renderer/App.tsx`
- geometry admission / frozen input：`src/renderer/components/MessageList.tsx`
- continuity transaction：`src/renderer/hooks/useChatScrollController.ts`

回归测试至少覆盖：visible blur 零恢复命令、latest-wins native sampling、generation reducer、inactive/最小化 frozen input、首次在恢复 generation mount、follow/anchor 两种恢复、unmounted anchor event-driven settlement、Session switch、旧 generation callback、显式用户导航抢占和 inactive Tab memo 隔离。Windows WebView2 与 macOS WKWebView 真机还要验证事件时线和无首句/顶部/底部闪跳；源码审计不能代替真机门禁。

连续输出回归：`npm run verify:chat-scroll -- webkit` 和 `npm run verify:chat-scroll -- chrome` 使用真实 Message/Markdown/controller/Virtuoso、合成对话及离线本地 Vite；测试会输出临时录像与几何快照目录。Node 补丁测试覆盖两个模块格式、幂等与版本/字节不匹配。
