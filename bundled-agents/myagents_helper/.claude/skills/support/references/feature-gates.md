# 实验门控与功能入口

使用场景：用户说某个功能入口没有、设置页找不到、工具箱模块不显示、外部 Runtime 选项不存在、CLI 工具注册不可用。

## Ground truth

部分功能是实验室开关，默认关闭。小助理要解释并引导用户打开，不要通过 config 绕过人类可见门控。

## 当前关键门控

### 更多 Agent Runtime

- 设置位置：设置 -> 关于&反馈 -> 实验室 -> 更多 Agent Runtime
- 配置字段：`multiAgentRuntime`
- 默认关闭
- 关闭时：Agent 实际跑 builtin；外部 runtime 的 UI/选择和配置可能不可见或不生效
- 只管 `runtimeSource=system-cli` 的外部 Runtime。`codex-sub` 这类 `runtimeSource=managed-provider` 的订阅 Provider 不按这个实验门控判断，而按 Provider readiness 判断。

诊断：

```bash
myagents runtime list --json
myagents agent show <agent-id> --json
rg -n "multiAgentRuntime|runtimeSource|managed-provider|codex-sub" ./logs/unified-*.log | tail -120
```

### CLI 工具注册表

- 设置位置：设置 -> 关于&反馈 -> 实验室 -> CLI 工具注册表
- 配置字段：`cliToolRegistryEnabled`
- 默认关闭
- 关闭时：
  - Settings 工具箱不渲染 CLI 工具模块
  - `myagents tool --help` 只显示开启指引
  - `myagents tool ...` 管理 API 被门控
  - 用户注册工具不会注入新 session prompt
  - `tool-creator` skill 不注入工作区
- 不受影响：稳定内置 `myagents` CLI，例如 cron/task/model/mcp/runtime/status/version
- 不能通过 `myagents config set cliToolRegistryEnabled ...` 开启

诊断：

```bash
myagents tool --help
```

## 回答方式

- 说明这是实验功能，默认关闭是产品策略，不是用户配置坏了。
- 给出设置路径。
- 如果用户当前任务可以不用该实验功能完成，先用稳定 CLI 完成一次性需求。
- 如果用户明确要使用实验功能，引导其手动打开开关，然后新开 session 或发新消息让 prompt/skill 集合刷新。
