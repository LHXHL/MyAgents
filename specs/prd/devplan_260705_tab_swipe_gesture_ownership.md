# 顶层 Tab 滑动与内层横向滚动手势归属修复

## 需求摘要

当前应用支持在主内容区用触控板双指左右滑动切换顶部 Tab，整体手感已经调优过；但当鼠标位于 Markdown 表格、文件预览、附件横条、表格 viewer 等本身应支持横向滚动的区域时，顶层 Tab swipe 会优先接管横向 wheel，导致内层横向滚动被抢走。目标是在不改变普通空白 / 正文区域左右滑动切 Tab 手感的前提下，让内层横向交互区域拥有本次手势优先权。

明确不做：
- 不重写现有 `useTabSwipeGesture` 的速度、阈值、惯性、动画、cooldown 手感。
- 不逐个业务组件手写 `stopPropagation` 或局部补丁。
- 不新增用户设置项。

## 执行台账

### 开发契约（动第一行代码前写完）
- 必赢场景：鼠标位于 Markdown 表格等横向滚动区域时，双指左右滑动优先滚动/留在该区域，不触发顶部 Tab 切换；鼠标位于普通内容区时，原有左右滑动切 Tab 行为保持不变。
- 复用的既有抽象：`src/renderer/hooks/useTabSwipeGesture.ts` 的 wheel 状态机、`direction: 'inner-scroll'` 分支、现有 `hasInnerHorizontalScroll` 单测、`myagents:tab-swipe-trace` 诊断日志。
- 反向边界：不改变 TabBar 自身横向滚动；不改 Markdown 表格视觉结构；不改 Electron/Tauri 原生手势；不处理触摸屏 pointer 手势。
- 新概念清单：`horizontal gesture owner`，把“这次横向 wheel 应归谁处理”从 tab swipe 状态机中抽成可测试规则。必要性：当前 owner 判断嵌在状态机里，且只按“当前是否还能 scrollLeft”判断，无法稳定覆盖内层横向交互区域。
- 触及的红线：前端开发需遵循 `DESIGN.md`，本次不做视觉改动；React effect 依赖保持现有稳定 ref 模式；共享 hook 改动必须补回归测试；已有无关 worktree 修改不得带入提交。

### 行动清单
- [x] 提炼横向手势归属判断，保留现有 tab swipe 状态机手感。
- [x] 更新/补充 `useTabSwipeGesture` 回归测试，覆盖内层横向滚动区域和普通区域。
- [x] 运行 targeted test、typecheck、lint、build、完整测试。
- [x] 需求符合性检查与 cross-review。
- [x] 提交本次修复，记录 commit。

### 待用户决策

无。

### 进展日志
- 2026-07-05：已确认根因在 `useTabSwipeGesture` 的内层横向滚动判定过窄，且到边界后会 relock 给 tab swipe；采用手势归属 gate 而不是业务组件补丁。
- 2026-07-05：已新增 `tabSwipeGestureOwnership` 纯判断模块，并接入 `useTabSwipeGesture`；定向 DOM 测试 `npx vitest run --project dom src/renderer/hooks/useTabSwipeGesture.test.tsx` 通过（19 tests）。
- 2026-07-05：静态验证和构建通过：`npm run typecheck && npm run lint`（depcruise 仅既有 `chatSuggestions.ts` orphan warning）、`npm run build:web`（仅既有 Vite chunk/dynamic import warnings）、完整 `npm test` 通过。
- 2026-07-05：cross-review 后收紧实现：移除未使用的 data attribute escape hatch；不再依赖 computed overflow，避免纵向滚动容器被浏览器归一化成横向 owner；补充 native `defaultPrevented`、边界不交接、离开 owner relock、纵向容器、hidden/clip、Text node target 等回归测试。
- 2026-07-05：重新验证通过：`npm run typecheck && npm run lint && npx vitest run --project dom src/renderer/hooks/useTabSwipeGesture.test.tsx && npm run build:web`；`npm test`。
- 2026-07-05：准备提交 `fix(ui): respect nested horizontal scroll ownership`。
