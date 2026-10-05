# 实验门控与功能入口诊断

使用场景：功能入口、设置项、Runtime、CLI 工具注册表或 Team Space 看不到。

先读 `/myagents-docs/references/settings-safety.md`。实验功能不可见通常是正常门控；只有满足门控后仍不出现才进入 Bug 诊断。

## 总原则

- 实验室开关需要用户在可见 UI 中主动开启，不通过 config 或内部 store 绕过。
- 区分“当前构建不包含能力”“实验开关关闭”“现场 readiness 不满足”“入口 render 异常”。
- 开关打开后，涉及 prompt/Skill/Runtime discovery 的能力可能需要新消息或新 Session；导航入口应按各自产品契约出现。

## Agent 运行环境

- 当前发行版直接开放 Agent Runtime 选择；不要求旧 `multiAgentRuntime` 实验开关。
- 通用设置 → Agent 功能设置选择默认 Claude Agent SDK / DeepSeek Harness；Agent 明确选择与已有 Session identity 优先。
- 选项不可用时区分 Provider 约束、DSH 资源、系统 CLI 安装/登录、Managed Codex readiness；不能只改旧字段。

```bash
myagents runtime list --json
myagents agent show <agent-id> --json
rg -n "runtimeSource|defaultIntegratedRuntime|integrated-dsh|managed-provider|codex-sub" ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -120
```

## CLI 工具注册表

- 设置：设置 → 关于&反馈 → 实验室 → CLI 工具注册表
- 字段：`cliToolRegistryEnabled`，默认关闭
- 关闭时用户 CLI Tool 与 `tool-creator` 不注入；稳定内置 `myagents` CLI 不受影响

```bash
myagents tool --help
```

若关闭，help 只显示开启指引属于正常行为。开启后当前 Session 仍看不到工具描述时，再核对 Session 刷新边界和 tool registry sync。

## 协作空间 / Team Space

协作空间有两层入口可用性：

1. 当前 Tauri 构建必须包含 Space capability；不包含时设置会显示不可用原因。
2. 隐藏开发者开关 `teamSpaceDevGate` 只有显式 false 才关闭，默认开启；旧 `teamSpaceEnabled` 不再控制入口。配置加载完成后从侧栏「更多 → 协作空间」进入。

```bash
myagents space list --json
rg -n "\\[space\\]|Team Space|space_build_capability|teamSpaceDevGate|not enabled in this build|requires a Tauri build" ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -160
```

- build capability 不可用：这是发行构建能力边界，不应写 config 强开。
- capability 与开关均满足但侧栏/页面仍不出现：转 `frontend-render.md`。
- 入口出现但登录、数据或操作失败：转 `cloud-space.md`。

## Agent 网络与外部调用

- Agent 网络从侧栏「更多」进入；需要同账号入网、目标在线且开放 Agent，不是 Runtime 实验开关，也不是 Space Registered Agent。发现不完整或连接异常转 `agent-network.md`。
- 外部终端/AI 使用 CLI 需要「设置 → 外部调用」主动授权，默认关闭；App 内 Agent 的调用上下文由产品注入。401/403 先查调用来源、公开命令范围与授权状态，不读取或输出内部 token。

## 回答与验证

说明具体是哪一层门控、UI 入口和正常生效时机。如果用户当前目标可用稳定能力完成，可以给替代路径，但不要擅自开启实验功能。用户手动开启后，从原入口验证；仅看到字段变为 true 不算 UI 已恢复。
