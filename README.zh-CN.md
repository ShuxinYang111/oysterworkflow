# OysterWorkflow

[English](./README.md) | [简体中文](./README.zh-CN.md)

面向 AI Agent 的 workflow-to-capability infrastructure，支持 macOS 和 Windows。

[下载最新版](https://github.com/ShuxinYang111/oysterworkflow/releases/latest) | [发布记录](https://github.com/ShuxinYang111/oysterworkflow/releases) | [营销网站工作区](https://github.com/ShuxinYang111/oyster-marketing) | [反馈问题](https://github.com/ShuxinYang111/oysterworkflow/issues) | [商业授权](mailto:shuxin.y.97@gmail.com)

OysterWorkflow 会采集真实工作流证据，把它整理成可审查的 artifacts，并帮助你把最终能力安装到 OpenClaw 中。当前公开版本聚焦于可审查的 OpenClaw skill 生成，而更大的方向是从真实电脑工作中沉淀可复用的 Agent experience。

这个公开仓库是 OysterWorkflow 的发布主页，主要用于下载、发布记录、截图、产品文档、问题反馈，以及连接并行建设中的公开营销网站工作区。当前版本下，OysterWorkflow 源码仍为私有。

## 为什么这件事重要

Prompt 和 SOP 往往遗漏真实电脑工作的质感：页面状态、重试过程、本地上下文、UI 切换，以及一个任务真正成功所依赖的执行顺序。OysterWorkflow 的目标，就是把这条原本看不见的路径沉淀成可复用资产。

## 谁适合试用

如果你符合下面这些情况，OysterWorkflow 会比较值得试：

- 经常重复桌面或浏览器流程，希望先把真实路径完整采集一次
- 正在构建 AI Agent、RPA、workflow automation 或 developer productivity 工具
- 想把复杂运营流程整理成可审查、可复用的 artifacts
- 希望在安装或复用生成能力之前，保留人类审查环节

当前发布范围刻意保持较窄：macOS Apple Silicon、Windows x64、公开非商业发布、源码私有。

## OysterWorkflow 当前能做什么

- 从屏幕活动、OCR、UI events、输入轨迹和可选语音讲解中采集工作流证据
- 将一次录制 session 提炼为值得审查的候选工作流
- 生成可审查的 OpenClaw skill artifacts，例如 `skill.json`、`assets.json` 和 `summary.json`
- 在导出或安装前保留人工检查和判断
- 将完成的 skill 直接安装到 OpenClaw skill 目录

## 从 Workflow 到 Capability

1. 先真实完成一次工作流。
2. 审查识别出的候选工作流，并选择真正有价值的那条路径。
3. 检查生成的 skill 草稿和证据说明。
4. 将最终能力安装到 OpenClaw 中，供后续复用。

## 产品截图

### 采集与录制状态

在一个界面中开始、停止或安排采集任务，同时查看 OCR 语言优先级、音频采集、录制器状态和桌面录制器准备情况。

![OysterWorkflow recorder dashboard with capture controls and status cards](./assets/screenshots/01-recorder-dashboard.png)

### 工作流候选发现

查看从录制 session 中识别出的候选工作流、阶段摘要，并选择继续使用生成的候选工作流或手动创建。

![OysterWorkflow workflow candidate discovery screen](./assets/screenshots/02-workflow-candidates.png)

### Skill 草稿审查

在安装结果之前，检查生成的 OpenClaw skill steps 和 evidence notes。截图中的敏感个人信息和账号相关细节已做脱敏处理。

![OysterWorkflow generated skill steps with sensitive details redacted](./assets/screenshots/03-skill-steps-redacted.png)

### Skill 管理与安装提示

管理已安装的 skills，复制推荐执行提示词，并在不再需要时卸载生成的 skills。

![OysterWorkflow skill manager with generated skills and copy prompt controls](./assets/screenshots/04-skill-manager-installation.png)

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

- macOS 和 Windows 发布包下载
- 发布记录
- 截图和产品文档
- 安装与使用问题反馈
- 指向并行营销网站工作区的链接

它不包含 OysterWorkflow 的私有源码。

## Roadmap 与反馈

- 当前方向见 [ROADMAP.md](./ROADMAP.md)。
- 反馈方式和 issue 指南见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
- 安装问题、workflow generation 反馈和功能建议请使用 [GitHub Issues](https://github.com/ShuxinYang111/oysterworkflow/issues)。

## FAQ

**这个仓库是开源仓库吗？**

不是。这个公开仓库用于发布二进制包、文档、截图和 issue tracking。OysterWorkflow 源码当前仍为私有。

**之后会开放源码或 SDK 吗？**

有可能。未来会考虑开放部分源码、SDK 或集成接口，尤其是 artifacts 和 runtime integration 相关部分，但当前 release 不承诺时间表或具体范围。

**OysterWorkflow 会生成什么？**

当前流程会生成可审查的 OpenClaw skill artifacts，典型文件包括 `skill.json`、`assets.json` 和 `summary.json`。

**可以商业使用吗？**

公开 release 许可不包含商业授权。公开版本使用 PolyForm Noncommercial 1.0.0，商业使用需要单独书面许可。

**录制一次之后就能完全自动化所有工作流吗？**

不能。当前产品重点是采集 workflow evidence、发现候选工作流、生成可审查 artifacts，并让用户在复用前检查结果。

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
