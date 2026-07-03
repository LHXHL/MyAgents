# Tool Attachment 与富媒体诊断

使用场景：图片、音频、PDF、截图等工具产物生成了但不显示；Codex `image_generation` 有结果没图；IM 没发出媒体；工具卡有路径但 gallery 空白。

## Ground truth

- MyAgents 用统一 `ToolAttachment[]` 管线渲染媒体，不应该依赖单个工具的专用卡片。
- 产物可能来自三类路径：
  - `~/.myagents/generated/tool-attachments/<sessionId>/<toolUseId>/`：Sidecar 归档后的 tool attachment。
  - `<workspace>/myagents_files/<tool>/`：部分工具按工作区产物目录落盘。
  - 外部 runtime 原始 `savedPath`：例如 Codex 生成图片后把路径交给 Sidecar registry 引用。
- 流程可能先发 placeholder，再通过 `chat:tool-attachment-update` 替换成真实 attachment。
- attachment endpoint/protocol 归当前 session owner sidecar 管。跨 sidecar 直接拉另一个 session 的 attachment 不是支持边界；但当前可见 session 已有 attachment 却没有注册/无法读取，是 bug 线索。
- 不要把大 base64 贴进报告。只报告路径、文件名、大小、MIME、错误行。

## 取证

```bash
find ./generated/tool-attachments -maxdepth 4 -type f 2>/dev/null | tail -40
find . -path "*/myagents_files/*" -type f 2>/dev/null | tail -40
rg -n "tool-attachment|ToolAttachment|chat:tool-attachment-update|attachment|imageGeneration|image_generation|savedPath|sourcePath|ToolAttachmentGallery|myagents://|error://|rejected_path|too_large|unsupported_url" ./logs/unified-*.log | tail -180
rg -n "\\[AppErrorBoundary\\]|\\[REACT\\] \\[ERROR\\]" ./logs/unified-*.log | tail -60
```

## 判断

- 工具 result 文本有路径，但没有 attachment：后端提取/落盘链路问题。
- 有 placeholder，没有 update：异步落盘或 update SSE 失败。
- 有 attachment 文件，前端不显示：registry、URL/protocol/endpoint、CSP、gallery 或 image/audio 组件问题。
- Codex 生成图：优先看 `savedPath` 和 `runtimeSource`，fallback 是 base64 解码落盘。不要只查 MCP gemini-image 分支。
- IM 媒体没发：先确认对话流内 attachment 存在，再查 IM 转发链路。

## 报告要点

Bug report 里带：
- sessionId、toolUseId（如果日志可见）
- attachment 文件相对路径、大小、MIME
- 工具名和 runtime
- placeholder/update 是否出现
- 前端是否有 AppErrorBoundary 或加载失败
