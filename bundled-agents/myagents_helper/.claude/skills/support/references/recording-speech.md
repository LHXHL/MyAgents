# 录音、离线转写与语音模型诊断

使用场景：录音没有声音、实时文字迟迟不出现、停止后处理失败、重新转写或人物归属异常、模型安装失败，或工作区附件 speech job 不可用。

先读 `/myagents-docs/references/automation.md`。Record 录制/会后整理与 Session 附件转写是不同路径，不能拿一种 job 的状态证明另一种已完成。

## 被动取证

```bash
myagents version
myagents record list --kind audio --json
rg -n 'RECORDING_|SPEECH_|\[recording\]|\[speech\]|worker-ready|stage-change|worker-completed|terminal' ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -180
```

先从详情页取得 Record/job/generation、来源音轨、处理 stage、失败 code 和操作时间。`record get` 可能包含完整私密正文，仅在用户授权且确需内容时读取，不把转写、人物名、音频、路径或原始 Worker stderr 发到报告。

附件 job 必须在发起它的原 Session 运行 `myagents speech status <job-id>` / `list`，小助理自己的 Session 不能读取其它 Session 的 job。`SPEECH_JOB_NOT_FOUND` 可能是 scope 不同，不应通过复制身份环境绕过。

## 分界判断

- 不能开始采集：查系统权限、选定设备与唯一录音槽；不要先安装模型来修设备权限。
- 文件保存但没有实时文字：录音 admission 时模型未就绪可只录音。模型安装不会自动处理历史 Record；从详情显式开始转录。
- 停止后等待：按 live 收尾、资源排队、全文整理、人物处理、发布与 terminal 区分，不把全部等待称为模型推理慢。录音结束后的旧处理不应一直阻止下一次采集。
- 推理/发布失败：保留最后确认的 stage 与具体 code；原音频、已有 final 与新候选分别判断，不删旧稿或把 partial 目录当成功。
- 重转失败/取消：旧稿应继续可读，成功才更新；人工人物标注按有效证据继承，不能承诺每次原样映射。
- 人物错误：mic/system 是来源而非人物身份；多人/未知/同时发言是合法状态。用户可以改名、合并或调整段落归属，不自动把麦克风设为“我”。
- 播放计时前进却无声：先查所选音轨、系统输出与媒体播放链；有逐字稿不证明音频播放健康。
- 模型维护失败：查安装/校验/资源 readiness，已安装兼容资源应保留；不要求系统 Node 或 FFmpeg，不改模型 manifest 绕过校验。
- 附件 job：只接受原 Workspace 普通文件，拒绝 URL、symlink/路径逃逸与不支持格式。App 重启后非终态 job 可为 interrupted；停止 CLI 等待不等于取消任务。
- 录音防休眠只防 idle sleep，不保证合盖、主动睡眠、断电时继续采集。

## 恢复与验证

重转、重新提交附件、安装/移除模型和删除 Record 会改变状态或重新计算，按明确授权执行。不要通过删除记录、改内部 store 或反复新建 job 测试只读查询。

用原入口与同类输入确认采集/归档 → 转写 → 人物/发布 → 播放或 artifact 的相关链路。报告只保留版本/OS、Record/job/generation、模型资源 revision、阶段/错误、计数与耗时；算法质量问题区分识别文字、分段、来源融合和人物归属。
