# OysterWorkflow

[English](./README.md) | [简体中文](./README.zh-CN.md)

面向 autonomous agents 的 work experience layer，支持 macOS 和 Windows。

[官网](https://oysterworkflow.vercel.app/) | [下载最新版](https://github.com/ShuxinYang111/oysterworkflow/releases/latest) | [发布记录](https://github.com/ShuxinYang111/oysterworkflow/releases) | [反馈问题](https://github.com/ShuxinYang111/oysterworkflow/issues) | [商业授权](mailto:shuxin.y.97@gmail.com)

OysterWorkflow 会采集人类和 Agent 在电脑上观察到什么、如何反应、如何完成真实工作。它把 screen states、OCR text、clicks、keystrokes、retries、choices 和 verification moves 转化为 AI agents 可复用的 experience。

当前公开版本会从桌面 workflow evidence 中生成可审查的 OpenClaw skills。更大的方向，是建立一个 workflow data、artifact 和 evaluation loop，让未来 Agent 拥有“工作如何成功”的记忆。

## 核心想法

Autonomous agents 需要的不只是 instructions，还需要 work memory。

真实工作通常不只是推理或清单，而是一组 experience patterns：noticing、deciding、trying、fixing、verifying 和 finishing。OysterWorkflow 会从真实电脑工作中保留这些模式，让 Codex、Claude Code、Cursor、OpenAI Agents、OpenClaw 和 custom agents 这类 agent stacks 可以复用已经成功过的路径。

## Work 如何变成 Agent Experience

1. **Capture real work.** 开始、暂停和回看桌面工作，同时把 screen states、OCR text、inputs、windows 和可选语音讲解保存为证据。
2. **Detect the meaningful pattern.** 在嘈杂 session 中识别真正有意义的工作模式：什么发生了变化、什么值得关注、任务在哪里真的推进了。
3. **Structure the experience.** 把采集到的工作整理为可复用的 noticing rules、retry logic、verification checks 和 completion conditions。
4. **Hand it to the agent ecosystem.** 最终 artifact 会成为 agent-ready memory 和 runtime material，当前首先落在 OpenClaw skills 上。

## Agent 能获得什么

- **Goal retention:** Agent 会锚定已经示范成功的结果，而不只是重新解释一段新 prompt。
- **Workflow fidelity:** Agent 可以沿着真实软件里成功过的路径走，而不是每次都即兴摸索页面和工具。
- **Preference alignment:** 命名习惯、文件夹结构、清理标准和判断规则可以延续下去。
- **Repeatability:** 重复工作可以复用更稳定的 experience layer，而不是每次从零解决。
- **Edge-case handling:** retries、failed clicks、changed pages、ambiguous states 和 verification moves 会继续留在记忆里。
- **Less prompting:** 用户不需要每次重复写很长的 setup prompts。
- **Long workflow support:** 多步骤任务会保留让它长期保持连贯的 decision chain。

## 当前 Runtime Artifact

OpenClaw skills 是当前第一个 runtime artifact，但不是产品最终边界。

当前公开版本聚焦于：

- `skill.json`，保存生成的 skill definition
- `assets.json`，保存采集到的 supporting evidence
- `summary.json`，保存 run 和 generation context
- 在安装或复用生成能力前保留 human review

## 产品截图

### Recorder control

开始、暂停和回看真实桌面工作，并将 screen states、OCR text、inputs、windows 和可选语音讲解作为 evidence 捕获下来。

![OysterWorkflow recorder dashboard with capture controls and status cards](./assets/screenshots/01-recorder-dashboard.png)

### Candidate workflow detection

审查 OysterWorkflow 从嘈杂 session 中识别出的工作模式，并选择值得转化为 reusable agent experience 的路径。

![OysterWorkflow workflow candidate discovery screen](./assets/screenshots/02-workflow-candidates.png)

### Skill draft review

在安装结果之前，检查生成的 OpenClaw steps 和 evidence notes。截图中的敏感个人信息和账号相关细节已做脱敏处理。

![OysterWorkflow generated skill steps with sensitive details redacted](./assets/screenshots/03-skill-steps-redacted.png)

### Skill manager and agent handoff

管理已生成的 skills，复制推荐执行提示词，并在能力不再有用时移除它。

![OysterWorkflow skill manager with generated skills and copy prompt controls](./assets/screenshots/04-skill-manager-installation.png)

## 谁适合试用

OysterWorkflow 更适合这些用户：

- 经常重复桌面或浏览器流程，希望先把真实路径完整采集一次
- 正在构建 AI Agent、RPA、workflow automation 或 developer productivity 工具
- 想把复杂运营流程整理成可审查、可复用的 artifacts
- 关心 user preferences、recovery logic 和 verification checks
- 希望在安装或复用生成能力之前保留人工审查

## 下载

从 [Releases](https://github.com/ShuxinYang111/oysterworkflow/releases/latest) 下载最新版 macOS 或 Windows 构建。

当前发布文件：

- `OysterWorkflow-0.1.0-arm64.dmg`
- `OysterWorkflow-Setup-0.1.0.exe`

SHA-256：

```text
macOS arm64 dmg:
711fe49c3abeb66e109c1ab78476b09978d3c83c042b922a58a6affa46d16187

Windows x64 installer:
78dad16a0e9152173d128ca5c2674a4987c61a4245e5f67bd2650654687bf0cf
```

## 系统要求

- macOS Apple Silicon (`arm64`)
- Windows x64

## 安装说明

### macOS

1. 从最新 release 下载 `OysterWorkflow-0.1.0-arm64.dmg`。
2. 打开 `.dmg`，将 `OysterWorkflow.app` 拖入 `Applications`。
3. 从 `Applications` 启动 OysterWorkflow。
4. 按提示授予必要的 macOS 权限。
5. 如果刚刚开启了录制相关权限，建议退出并重新打开应用一次，再开始录制。

因为 OysterWorkflow 需要采集工作流证据，macOS 可能会请求以下权限：

- Screen Recording
- Accessibility
- Input Monitoring
- Microphone，当启用语音讲解时需要

### Windows

1. 从最新 release 下载 `OysterWorkflow-Setup-0.1.0.exe`。
2. 运行安装器。
3. 从开始菜单或安装目录启动 OysterWorkflow。
4. 只有在需要采集语音讲解时才启用录制器音频。

Windows 注意事项：

- Windows 构建为 x64。
- Windows 版本暂时不支持应用内中文输入。
- Windows 语音转写当前更适合英文；本版本中文语音转写不可靠。

## 这个公开仓库包含什么

这个公开仓库用于发布二进制包、文档、截图、issue tracking 和官网入口。它不包含 OysterWorkflow 的私有源码。

## Roadmap 与反馈

- 当前方向见 [ROADMAP.md](./ROADMAP.md)。
- 反馈方式和 issue 指南见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
- 安装问题、workflow generation 反馈和功能建议请使用 [GitHub Issues](https://github.com/ShuxinYang111/oysterworkflow/issues)。

## FAQ

**这个仓库是开源仓库吗？**

不是。这个公开仓库用于发布二进制包、文档、截图和 issue tracking。OysterWorkflow 源码当前仍为私有。

**OysterWorkflow 现在会生成什么？**

当前流程会生成可审查的 OpenClaw skill artifacts，典型文件包括 `skill.json`、`assets.json` 和 `summary.json`。

**录制一次之后就能完全自动化所有工作流吗？**

不能。当前产品重点是采集 workflow evidence、发现候选工作流、生成可审查 artifacts，并让用户在复用前检查结果。

**为什么叫 experience layer？**

因为真正重要的不只是最终 instruction。OysterWorkflow 会记录 observed context、user choices、recovery moves 和 verification checks，用来解释工作实际上是如何成功的。

**可以商业使用吗？**

公开 release 许可不包含商业授权。公开版本使用 PolyForm Noncommercial 1.0.0，商业使用需要单独书面许可。

**公开 issue 里不要发什么？**

请不要公开发布密码、私有 URL、账号信息、客户数据或敏感截图。经过脱敏的 workflow 描述比原始隐私数据更有帮助。

## 许可

公开发布版本使用 [PolyForm Noncommercial 1.0.0](./LICENSE) 许可。

简单来说：

- 你可以下载并将公开发布版本用于非商业用途
- 你不会获得私有源码的使用权
- 公开发布条款不授权商业使用

请阅读 [LICENSE-SUMMARY.md](./LICENSE-SUMMARY.md) 查看简明许可摘要。

如需商业授权，请联系：`shuxin.y.97@gmail.com`
