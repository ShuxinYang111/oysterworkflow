import { APP_LANGUAGES, type AppLanguage } from "./app-language";

const TEXT_NODE_ORIGINALS = new WeakMap<Text, string>();
const ELEMENT_ATTRIBUTE_ORIGINALS = new WeakMap<Element, Map<string, string>>();

const TRANSLATABLE_ATTRIBUTES = ["aria-label", "placeholder", "title"] as const;

const ZH_TEXT: Record<string, string> = {
  Sessions: "会话",
  Settings: "设置",
  "Message channel": "消息渠道",
  "Connect an account, verify a real message, then bind it.":
    "连接账号，验证真实消息，然后绑定会话。",
  "Setup progress": "设置进度",
  "Connect Slack": "连接 Slack",
  "Create a Socket Mode app, then paste its xoxb bot token and xapp app token.":
    "创建 Socket Mode 应用，然后粘贴 xoxb Bot Token 和 xapp App Token。",
  "Create the right Slack bot": "创建正确的 Slack Bot",
  "Use an app manifest so Socket Mode, message events, App Home, and bot permissions are configured together.":
    "使用 App Manifest，一次配置 Socket Mode、消息事件、App Home 和 Bot 权限。",
  "Open Slack app creator": "打开 Slack 应用创建页面",
  "Copy app manifest": "复制 App Manifest",
  "Manifest copied": "Manifest 已复制",
  "Create from an app manifest": "从 App Manifest 创建",
  "Choose your Slack workspace, paste the copied JSON, then create or update the app.":
    "选择 Slack 工作区，粘贴已复制的 JSON，然后创建或更新应用。",
  "Create the xapp token": "创建 xapp Token",
  "Basic Information - App-Level Tokens - Generate Token and Scopes. Add connections:write.":
    "依次打开 Basic Information、App-Level Tokens、Generate Token and Scopes，并添加 connections:write。",
  "Install the app for the xoxb token": "安装应用并取得 xoxb Token",
  "Install App - Install to Workspace. Copy the Bot User OAuth Token after Slack authorizes it.":
    "依次打开 Install App、Install to Workspace。Slack 授权后复制 Bot User OAuth Token。",
  "Paste both tokens below": "在下方粘贴两个 Token",
  "App ID, Client Secret, Signing Secret, and Verification Token are not accepted here.":
    "这里不接受 App ID、Client Secret、Signing Secret 或 Verification Token。",
  "Bot token": "Bot Token",
  "App token": "App Token",
  "Bot User OAuth Token from Install App.":
    "来自 Install App 页面的 Bot User OAuth Token。",
  "App-level token with connections:write from Basic Information.":
    "来自 Basic Information、包含 connections:write 的 App-Level Token。",
  "Who can message this worker?": "谁可以给这个 Worker 发消息？",
  "User IDs or handles, separated by commas": "用户 ID，用英文逗号分隔",
  "Leave blank only for a private engineering canary.":
    "仅限私有工程测试时留空。",
  "Got a pairing code?": "收到配对码了吗？",
  "Paste the 8-character code Slack sent you. Oyster approves this user on this computer.":
    "粘贴 Slack 发来的 8 位配对码。Oyster 将在这台电脑上批准该用户。",
  "Pairing code": "配对码",
  "Approve code": "批准配对码",
  "Approving...": "正在批准...",
  "Refresh messages": "刷新消息",
  "Enter the 8-character code Slack sent you.":
    "请输入 Slack 发来的 8 位配对码。",
  "New messages in this conversation will resume this exact session.":
    "此会话中的新消息将继续运行这个 AI Worker 会话。",
  "New messages in this conversation now resume the selected AI worker session. You can change or remove the binding later without reconnecting the account.":
    "此会话中的新消息现在会继续运行所选 AI Worker 会话。之后可以更改或移除绑定，无需重新连接账号。",
  "Change conversation": "更换会话",
  "Switch app": "切换 App",
  "Switch message app": "切换消息 App",
  "Disconnect current app": "断开当前 App",
  "Disconnecting...": "正在断开...",
  Connected: "已连接",
  "Messages are ready": "消息路由已就绪",
  "Connect and verify": "连接并验证",
  "Connecting...": "正在连接...",
  "Slack Bot token must start with xoxb-. Install the app to the workspace and copy the Bot User OAuth Token, not the App ID or Client Secret.":
    "Slack Bot Token 必须以 xoxb- 开头。请将应用安装到工作区并复制 Bot User OAuth Token，不要填写 App ID 或 Client Secret。",
  "Slack App token must start with xapp-. Enable Socket Mode and create an app-level token with connections:write, not a Signing Secret or Verification Token.":
    "Slack App Token 必须以 xapp- 开头。请启用 Socket Mode，并创建包含 connections:write 的 App-Level Token，不要填写 Signing Secret 或 Verification Token。",
  "Workspace profile": "工作区资料",
  "Account settings": "账号设置",
  "Sign out": "退出登录",
  Close: "关闭",
  General: "通用",
  Recorder: "录制器",
  "Learning Mode": "学习模式",
  Permissions: "权限",
  Model: "模型",
  Capture: "采集",
  Controls: "控制",
  Status: "状态",
  "Current recorder state": "当前录制器状态",
  "Start Recording": "开始录制",
  "Stop Recording": "停止录制",
  "Start Timed Recording": "开始定时录制",
  "Schedule Stop": "安排停止",
  "Stop after": "停止于",
  minutes: "分钟后",
  "OCR Priority": "OCR 优先级",
  Audio: "音频",
  Language: "语言",
  "Not set": "未设置",
  "Ready to record": "可开始录制",
  "Ready to learn": "可开始学习",
  "Selected Session": "所选会话",
  "Selected session state": "所选会话状态",
  "Review in Settings": "在设置中查看",
  "Needs attention": "需要处理",
  "Loading...": "加载中...",
  "Checking...": "检查中...",
  "Checking recorder permissions now...": "正在检查录制器权限...",
  "Checking Learning Mode permissions now...": "正在检查学习模式权限...",
  "Checking macOS access now...": "正在检查 macOS 访问权限...",
  "All required recorder permissions are available.":
    "必需的录制器权限均已可用。",
  "All required macOS permissions are available.":
    "必需的 macOS 权限均已可用。",
  "Retry in Settings": "在设置中重试",
  "Configure in Settings": "在设置中配置",
  "No sessions yet. Start a recording to create one.":
    "暂无会话。开始录制后会创建一个会话。",
  "The session that is currently recording cannot be deleted.":
    "当前正在录制的会话不能删除。",
  "Delete session": "删除会话",
  "Delete workflow": "删除工作流",
  "Selection needed": "等待选择",
  "Delete AI worker": "删除 AI Worker",
  "Delete this AI worker": "删除此 AI Worker",
  "Delete worker": "删除 Worker",
  "Cancel delete AI worker": "取消删除 AI Worker",
  "Deleting...": "正在删除...",
  "Stop the active AI worker session before deleting it.":
    "请先停止正在运行的 AI Worker 会话，再执行删除。",
  "Remove its device assignment, installed workflows, and message routing. Run history is kept for audit.":
    "移除设备分配、已安装工作流和消息路由。运行历史将保留用于审计。",
  "Cancel delete workflow": "取消删除工作流",
  "Keep at least one workflow in this workspace.":
    "当前工作区至少需要保留一个工作流。",
  "This removes the workflow from this workspace. Installed AI worker capabilities and raw captures are not changed.":
    "这会从当前工作区移除此工作流。已安装的 AI Worker 能力和原始采集不会改变。",
  enabled: "已启用",
  disabled: "已关闭",
  idle: "空闲",
  ready: "就绪",
  recording: "录制中",
  failed: "失败",
  starting: "启动中",
  stopping: "停止中",
  "Not started": "未开始",
  "Not scheduled": "未安排",
  "Recording Blocked": "录制被阻止",
  "Grant the required recorder permissions before recording.":
    "录制前请先授予必需的录制器权限。",
  "Grant the required macOS permissions before recording.":
    "录制前请先授予必需的 macOS 权限。",
  "Open Settings, grant access, then try recording again.":
    "打开设置并授予访问权限，然后再尝试录制。",
  "Open Settings": "打开设置",
  "A different session is still recording right now. The controls above still act on the active recorder session.":
    "另一个会话仍在录制中。上方控制仍会作用于当前活动的录制会话。",
  "Processing:": "处理中：",
  Elapsed: "已用时",
  "Start Time": "开始时间",
  "Scheduled Stop": "计划停止",
  "Review Capture": "检查采集",
  Workflows: "工作流",
  Workflow: "工作流",
  "Skill Builder": "技能构建器",
  "Skill Manager": "技能管理器",
  "Check what this session captured.": "检查本次会话采集到了什么。",
  "Detect workflows from capture or manually create one.":
    "从采集中识别工作流，或手动创建一个。",
  "Generate and review the draft.": "生成并检查草稿。",
  "Save the folder and install a result.": "保存文件夹并安装结果。",
  "Continue to Workflows": "继续到工作流",
  "Continue to Skill Builder": "继续到技能构建器",
  "Continue to Skill Manager": "继续到技能管理器",
  "Back to Review Capture": "返回检查采集",
  "Step 1 of 4": "第 1/4 步",
  "Step 2 of 4": "第 2/4 步",
  "Step 3 of 4": "第 3/4 步",
  "Step 4 of 4": "第 4/4 步",
  "Next Step": "下一步",
  "Main workflow": "主流程",
  "Finish capture review before moving to the workflow step.":
    "进入工作流步骤前，请先完成采集检查。",
  "Once ingest finishes for the selected session, continue to Workflows.":
    "所选会话处理完成后，继续到工作流。",
  "Next, choose the workflow you want to turn into a skill.":
    "下一步，选择要转成技能的工作流。",
  "Open Workflows to review discovered candidates or create one manually.":
    "打开工作流，检查已发现的候选项，或手动创建一个。",
  "Review what was captured in this session": "检查本次会话采集内容",
  "Retry Ingest": "重新处理采集",
  "Stage Summary": "阶段摘要",
  "What was captured": "采集内容",
  workflow: "工作流",
  "source events": "来源事件",
  steps: "步骤",
  warnings: "警告",
  variants: "变体",
  RunID: "运行 ID",
  RUNID: "运行 ID",
  "Run ID": "运行 ID",
  runId: "运行 ID",
  "Time Window": "时间窗口",
  "TIME WINDOW": "时间窗口",
  "Raw UI": "原始 UI",
  "RAW UI": "原始 UI",
  "raw UI": "原始 UI",
  "Raw OCR": "原始 OCR",
  "RAW OCR": "原始 OCR",
  "raw OCR": "原始 OCR",
  "Raw Audio": "原始音频",
  "RAW AUDIO": "原始音频",
  "raw audio": "原始音频",
  Normalized: "标准化",
  NORMALIZED: "标准化",
  normalized: "标准化",
  Deduped: "去重后",
  DEDUPED: "去重后",
  deduped: "去重后",
  Episodes: "片段",
  EPISODES: "片段",
  episodes: "片段",
  "Recording Duration": "录制时长",
  "RECORDING DURATION": "录制时长",
  "recording duration": "录制时长",
  "Technical Details": "技术细节",
  "Capture debug files": "采集调试文件",
  "Raw Warnings": "原始警告",
  "View summary.json": "查看 summary.json",
  "Next:": "下一步：",
  "SUMMARY.JSON": "summary.json",
  "RAW/AUDIO.NDJSON": "raw/audio.ndjson",
  "summary.json": "摘要 JSON",
  "raw/audio.ndjson": "原始音频 NDJSON",
  "No capture summary is available yet.": "暂时没有采集摘要。",
  "This section becomes available after recording stops and OysterWorkflow finishes processing the capture.":
    "录制停止并且 OysterWorkflow 完成采集处理后，此分区会变为可用。",
  "Finish the recording, then review the counts before finding workflows.":
    "先完成录制，再检查数量，然后查找工作流。",
  "Ingest completed cleanly and the captured evidence looks ready for workflow review.":
    "采集处理已干净完成，捕获的证据看起来已可用于工作流检查。",
  "Find workflows to pick the path worth turning into a skill.":
    "查找工作流，选择值得转成技能的路径。",
  "Verify recorder permissions or record again before continuing.":
    "继续之前，请检查录制权限或重新录制。",
  "Use these files when you need to inspect raw capture output or warnings.":
    "需要检查原始采集输出或警告时，可以查看这些文件。",
  "Capture results will appear here after recording stops and processing finishes.":
    "录制停止并处理完成后，采集结果会显示在这里。",
  "Find Workflows": "查找工作流",
  "Candidate Workflows": "候选工作流",
  "Find workflow candidates for Skill Builder": "为技能构建器查找工作流候选",
  "From here, Oyster can intelligently identify one or more workflow candidates from your recorded segment for Skill Builder to use. You can also create the workflow you want manually and skip this step.":
    "在这里，Oyster 可以从录制片段中智能识别一个或多个工作流候选，供技能构建器使用。你也可以手动创建想要的工作流并跳过此步骤。",
  "Create Workflow Candidate": "创建工作流候选",
  "Complete ingest first so the workflow stage has one trace to reference.":
    "请先完成采集处理，这样工作流阶段才有一条轨迹可参考。",
  "Found 2 candidate workflows in the current trace.":
    "当前轨迹中找到 2 个候选工作流。",
  'The current selection is "Priority 1 workflow". Use it when this card best represents the successful path you want to extract.':
    "当前选择是“Priority 1 workflow”。当这张卡片最能代表你想提取的成功路径时使用它。",
  'When you\'re ready, open Skill and generate from "Priority 1 workflow".':
    "准备好后，打开技能并从“Priority 1 workflow”生成。",
  "How to review workflow candidates": "如何检查工作流候选",
  "No workflow candidates are available yet.": "暂时没有可用的工作流候选。",
  "This stage groups the current session into reusable workflow candidates so the next step can focus on one clear path.":
    "此阶段会把当前会话整理成可复用的工作流候选，让下一步聚焦到一条清晰路径。",
  "Find workflows, then choose the candidate that best matches the reusable journey.":
    "先查找工作流，再选择最符合可复用流程的候选项。",
  "Run Find Workflows or create a workflow candidate manually to see workflow candidates here.":
    "运行“查找工作流”，或手动创建一个工作流候选后，就会在这里看到候选项。",
  "Create or discover a workflow candidate before moving on.":
    "继续之前，请先创建或识别一个工作流候选。",
  "Next, generate the first skill draft from a workflow.":
    "下一步，从工作流生成第一版技能草稿。",
  "Continue to Skill Builder with the current workflow ready.":
    "当前工作流已准备好，继续到技能构建器。",
  "Pick the workflow card you want first, then continue to Skill Builder.":
    "请先选择想使用的工作流卡片，再继续到技能构建器。",
  "Run Find Workflows or create a workflow card manually in this step.":
    "在这一步运行“查找工作流”，或手动创建一个工作流卡片。",
  "Use the LLM to extract skills from one or more workflows you choose.":
    "使用 LLM 从你选择的一个或多个工作流中提取技能。",
  "After the skills are extracted, head to Skill Manager to install them.":
    "技能提取完成后，前往技能管理器安装。",
  "The flow is complete. You can refine any earlier step anytime.":
    "流程已完成。你随时可以回到前面的步骤继续调整。",
  "Final step: save the folder path and install the result you want to keep.":
    "最后一步：保存文件夹路径，并安装你想保留的结果。",
  "Review Capture, Workflows, and Skill Builder stay available from the stepper above.":
    "你仍可通过上方步骤条进入检查采集、工作流和技能构建器。",
  "Once the folder path is saved, install the best result from this session here.":
    "文件夹路径保存后，在这里安装本会话中最合适的结果。",
  "Start by saving the folder path, then install a generated result when you are ready.":
    "先保存文件夹路径，准备好后再安装已生成的结果。",
  "Continue through the workflow.": "继续完成整个流程。",
  "Use the stepper above to move through the main flow.":
    "使用上方步骤条在主流程中切换。",
  "Workflow Card Draft": "工作流卡片草稿",
  "Name the workflow": "命名工作流",
  "Describe the repeatable path in plain English": "用简洁语言描述可复用路径",
  "Describe the outcome this workflow should achieve":
    "描述该工作流要达成的结果",
  "Edit Workflow Card": "编辑工作流卡片",
  "Workflow card saved.": "工作流卡片已保存。",
  "Title, description, and goal are required.": "标题、描述和目标均为必填。",
  "The workflow card could not be found.": "找不到该工作流卡片。",
  Skill: "技能",
  "Base Skill": "基础技能",
  Variants: "变体",
  Scenarios: "场景",
  "Agent Optimization": "智能体优化",
  "Build the skill, future variants, and agent optimization in steps":
    "分步生成技能、未来变体和智能体优化版本",
  "Generate a Skill": "生成技能",
  "Generate Skill": "生成技能",
  "Generation Guidance": "生成指导",
  "Tell the AI what to include, avoid, rename, or generalize.":
    "告诉 AI 哪些内容要包含、避免、改名或泛化。",
  "Use this to guide how the AI should generate the skill. Leave it blank to use the default generation mode.":
    "这里你可以提供指导，告诉 AI 应该如何生成技能，留空则按照默认模式生成。",
  "No workflows yet": "暂无工作流",
  "This skill reconstructs the user's own workflow, so it will usually be very specific. That is expected. When an AI agent handles a similar scenario later, it can use logically equivalent alternatives instead of copying the exact actions verbatim.":
    "这个技能会重建用户自己的工作流，因此通常会非常具体，这是预期行为。之后 AI 智能体处理类似场景时，可以使用逻辑等价的替代操作，而不必逐字复制原始动作。",
  "This skill reconstructs the user's own workflow, so it will usually be very specific. That is expected. When another AI agent handles a similar scenario later, it can use logically equivalent alternatives instead of copying the exact actions verbatim.":
    "这个技能会重建用户自己的工作流，因此通常会非常具体，这是预期行为。之后其他 AI 智能体处理类似场景时，可以使用逻辑等价的替代操作，而不必逐字复制原始动作。",
  "Run Find Workflows first, then choose one from the Skill dropdown and generate the draft.":
    "请先运行“查找工作流”，然后从技能下拉框选择一个工作流并生成草稿。",
  "Run Find Workflows first, then choose one from the dropdown above to generate the skill. Generated skill cards will stay here for each workflow in this session.":
    "请先运行“查找工作流”，然后从上方下拉框选择一个工作流来生成技能。本会话中每个工作流生成的技能卡片都会保留在这里。",
  "Predicted Cards": "预测卡片",
  "Not generated": "未生成",
  "Needs analysis": "待分析",
  "After analysis": "分析后显示",
  "Analyze capture": "分析采集",
  "Analyzing capture...": "正在分析采集...",
  "Open full workflow": "打开完整工作流",
  "Ready for workflow analysis": "可开始工作流分析",
  "Analyze this capture to build an editable workflow.":
    "分析这次采集，生成可编辑工作流。",
  "Screen, text, and voice captured": "已采集屏幕、文字和语音",
  "Captured session:": "已采集会话：",
  "Workflow draft is ready.": "工作流草稿已准备好。",
  "Workflow draft is ready for review.": "工作流草稿已可检查。",
  "Stopping training and preparing the capture...":
    "正在停止训练并准备采集内容...",
  "Training stopped. Review the capture and build a workflow.":
    "训练已停止。请检查采集内容并生成工作流。",
  "This sample workflow is already ready to review.":
    "这个示例工作流已可检查。",
  "Finding the main workflow in this capture...":
    "正在从本次采集中查找主工作流...",
  "Drafting editable workflow steps...": "正在生成可编辑工作流步骤...",
  "Preparing the workflow review...": "正在准备工作流检查...",
  "No step details are available yet.": "此步骤暂无详情。",
  "No guidance has been added for this step.": "此步骤暂无指导。",
  "This step belongs to the workflow draft.": "此步骤属于工作流草稿。",
  "Training is still recording. Stop training to prepare a review.":
    "训练仍在录制中。停止训练后即可准备检查。",
  "The capture is not ready for review yet.": "采集内容暂时还不能检查。",
  "Capture is ready. Analyze it to build an editable workflow.":
    "采集内容已准备好。分析后可生成可编辑工作流。",
  "AI workers": "AI Worker",
  "Train workers, assign computers, and manage sessions":
    "训练 Worker、分配电脑，并管理会话",
  "New AI worker": "新建 AI Worker",
  "Selected worker": "所选 Worker",
  "General purpose desktop worker": "通用桌面 Worker",
  Available: "可用",
  "Needs device": "需要设备",
  "Setup needed": "需要设置",
  "No active task": "暂无任务",
  Working: "工作中",
  Training: "训练中",
  "Waiting for user": "等待用户",
  Blocked: "已阻塞",
  "Recording desktop activity": "正在录制桌面活动",
  "Learning desktop activity": "正在学习桌面操作",
  "Finalizing capture": "正在完成采集",
  "Training session recording": "训练会话录制中",
  "Learning session active": "学习会话进行中",
  "Screen context capture active": "屏幕上下文采集中",
  "Screen context learning active": "屏幕上下文学习中",
  "Stop training to review the capture": "停止训练后检查采集内容",
  "Finish learning to review the workflow": "完成学习后检查工作流",
  "Active training capture": "正在进行的训练采集",
  "Captured training session": "已采集的训练会话",
  "Recently active": "最近可用",
  "No computer assigned": "未分配电脑",
  "Permissions missing": "权限缺失",
  "Device assignment needed": "需要分配设备",
  "Training materials prepared": "训练材料已准备",
  "Device capability check passed": "设备能力检查通过",
  "Training can start": "可以开始训练",
  "Approval policy ready": "审批策略已配置",
  "Training check complete": "训练检查已完成",
  "MacBook assigned": "MacBook 已分配",
  "WeChat channel configured": "微信通道已配置",
  "No active workflow running": "暂无运行中的工作流",
  Device: "设备",
  Availability: "可用性",
  Policy: "策略",
  "Approval policy": "审批策略",
  "Approval policy allow_all": "审批策略：allow_all",
  "Run events are live": "运行事件已实时记录",
  "Human review required": "需要人工审核",
  "Worker progress appears in run events": "Worker 进展会显示在运行事件中",
  "AI worker progress uses the normal run event history.":
    "AI Worker 进展使用普通运行事件历史记录。",
  "Train my AI worker": "训练我的 AI Worker",
  "Starting training...": "正在开始训练...",
  "Stopping training...": "正在停止训练...",
  "Stop training": "停止训练",
  "Start worker": "启动 Worker",
  "Stop worker": "停止 Worker",
  "AI worker ready": "AI Worker 已就绪",
  "AI worker required": "需要先启动 AI Worker",
  "Start AI worker first": "先启动 AI Worker",
  "Start the AI worker first, then run this workflow.":
    "你应该先启动 AI worker，然后再去执行",
  "Close AI worker required dialog": "关闭 AI Worker 启动提示",
  "Not now": "暂不",
  "Start AI worker": "启动 AI Worker",
  "Pause the active workflow before starting another one":
    "请先暂停当前正在执行的工作流，再开始另一个。",
  Deployed: "已部署",
  "Deploy to": "部署到",
  "Deploy to AI worker": "部署到 AI Worker",
  "Install a workflow from Workflows before you can run one.":
    "请先从工作流页面安装一个工作流，然后再运行。",
  "No active workflow is running. Start worker or run an installed workflow to send live commands.":
    "暂无运行中的工作流。开始工作或运行已安装工作流后，可发送实时指令。",
  "Run a workflow to send live commands": "运行工作流后可发送实时指令",
  "Assign device": "分配设备",
  Agent: "智能体",
  "Installed workflows": "已安装工作流",
  "Pull the signed-in account before pushing local AI worker changes.":
    "请先拉取当前登录账号的云端数据，再推送本地 AI Worker 变更。",
  "Workflow title and description are required.":
    "请先填写 workflow 标题和描述。",
  "Review workflow objective and source brief": "检查 workflow 目标和来源说明",
  "Confirm the outcome, required apps, and operating boundaries before installation.":
    "安装前请确认目标、所需应用和操作边界。",
  "Saved workflow brief": "已保存的 workflow 说明",
  "Manual entry": "手动创建",
  "Imported entry": "导入创建",
  Config: "配置",
  Activity: "活动",
  "Worker detail sections": "Worker 详情分区",
  "Installed workflow summary": "已安装工作流摘要",
  "Total runs": "总执行次数",
  "Successful runs": "成功次数",
  "Success rate": "成功率",
  Enabled: "已启用",
  Paused: "已暂停",
  "Needs review": "需要检查",
  "Manage the capabilities this worker can run on assigned devices.":
    "管理此 Worker 可在已分配设备上执行的能力。",
  Search: "搜索",
  "Search workflows": "搜索工作流",
  "Workflow filters": "工作流筛选",
  Runs: "执行次数",
  Success: "成功",
  "Last run": "上次执行",
  Actions: "操作",
  "View runs": "查看执行记录",
  Disable: "停用",
  Enable: "启用",
  Update: "更新",
  Review: "检查",
  More: "更多",
  "No installed workflows": "暂无已安装工作流",
  "Install a workflow from the Workflows page to give this worker a repeatable capability.":
    "从工作流页面安装一个工作流，让此 Worker 获得可重复执行的能力。",
  "Recent workflow runs": "最近工作流执行",
  "Needs approval": "需要审批",
  "Pending approvals": "待审批",
  "No approvals waiting.": "暂无待审批项。",
  "Runtime health": "运行健康状态",
  Heartbeat: "心跳",
  "Idle policy": "空闲策略",
  "Watching queue": "正在观察队列",
  "Recent activity": "最近活动",
  "Assigned device": "已分配设备",
  "Not assigned": "未分配",
  Assigned: "已分配",
  Configured: "已配置",
  Installed: "已安装",
  "Training in progress": "训练进行中",
  "No workflow installed": "未安装工作流",
  Approved: "已批准",
  "Work state": "工作状态",
  "Work active": "工作进行中",
  "Device assigned": "设备已分配",
  "Workflow installed": "工作流已安装",
  "No workflow": "无工作流",
  "Working now": "正在工作",
  "Reading inbox": "读取收件箱",
  "Searching context": "搜索上下文",
  "Approval boundary": "审批边界",
  "Opening Outlook": "打开 Outlook",
  Thinking: "思考中",
  "Qualifying inquiry": "判断询盘质量",
  "Checking Google": "检查 Google",
  "Checking LinkedIn": "检查 LinkedIn",
  "Asking ChatGPT": "询问 ChatGPT",
  "Waiting for tech team": "等待技术团队",
  "Preparing follow-up": "准备后续跟进",
  "Workflow started": "工作流已启动",
  Initialized: "已初始化",
  "Sales AI Worker Initialized": "Sales AI Worker 已初始化",
  Command: "指令",
  "Type start processing email to begin": "输入 start processing email 开始",
  "Working through the next screen step and waiting for the result...":
    "正在执行下一步屏幕操作并等待结果...",
  "AI worker initializing": "AI Worker 正在初始化",
  "AI worker working": "AI Worker 正在执行",
  "AI worker is working on the workflow...": "AI Worker 正在执行此工作流...",
  "Waiting for AI worker to finish initializing...":
    "正在等待 AI Worker 完成初始化...",
  "Worker is running the next step...": "Worker 正在执行下一步...",
  "Generate workflow": "生成工作流",
  "Generating workflow...": "正在生成工作流...",
  "Capture is ready. Generate it to build an editable workflow.":
    "采集已准备好。生成后可构建可编辑工作流。",
  "Installed workflow pages": "已安装工作流分页",
  "Showing 6 of 32 installed workflows": "正在显示 32 个已安装工作流中的 6 个",
  "Showing 7 of 32 installed workflows": "正在显示 32 个已安装工作流中的 7 个",
  "Showing 7 of 33 installed workflows": "正在显示 33 个已安装工作流中的 7 个",
  Waiting: "等待中",
  "Waiting for user action": "等待用户操作",
  "Assign a trusted computer": "分配一台可信电脑",
  "Assign a trusted computer before this worker can run desktop tasks.":
    "请先分配一台可信电脑，Worker 才能执行桌面任务。",
  "I am watching for new messages and will ask for approval before sending external replies or changing records.":
    "我会观察新消息；发送外部回复或修改记录前会请求审批。",
  "Checking current workflow context": "正在检查当前工作流上下文",
  "Approval boundary active": "审批边界已启用",
  "Found a new inbound message in Outlook. Checking sender domain and request detail before drafting any reply.":
    "在 Outlook 中发现新的入站消息。起草任何回复前，我会先检查发件人域名和需求细节。",
  "Opening internal references for similar cases, then I will ask engineering before making feasibility or pricing commitments.":
    "正在打开内部相似案例资料；在承诺可行性或价格前，我会先询问工程团队。",
  "External replies will stay in draft until Alex approves them.":
    "外部回复会保留为草稿，直到 Alex 批准。",
  "Worker settings": "Worker 设置",
  "Configure behavior, memory, and operating preferences":
    "配置行为、记忆和运行偏好",
  "Identity and scope": "身份与范围",
  "Define worker identity, role, and guidelines":
    "定义 Worker 身份、角色和准则",
  "Worker permissions": "Worker 权限",
  "Manage permissions and approval requirements": "管理权限与审批要求",
  "Availability checks": "可用性检查",
  "Set idle windows, check cadence, and recovery behavior":
    "设置空闲窗口、检查频率和恢复行为",
  "Computer access": "电脑访问",
  "Control what this worker can access on assigned devices":
    "控制此 Worker 在已分配设备上的访问范围",
  "Worker timeline": "Worker 时间线",
  "Approval mode": "审批模式",
  "Ask first": "先询问",
  "Worker health": "Worker 健康状态",
  "Assign AI workers to trusted computers and monitor availability":
    "将 AI Worker 分配到可信电脑，并监控可用状态",
  "Work queue": "工作队列",
  Devices: "设备",
  "Review trusted computers and worker assignments":
    "检查可信电脑与 Worker 分配",
  "Trusted computers": "可信电脑",
  "Keep worker assignments and availability visible":
    "显示 Worker 分配与可用性",
  "Available now": "当前可用",
  "Idle today": "今日空闲",
  "Not reachable": "无法连接",
  "Selected device": "所选设备",
  Owner: "所有者",
  "Assigned worker": "已分配 Worker",
  "Think when idle": "空闲时思考",
  "Review inbox when work starts": "开始工作后检查收件箱",
  "Prepare opportunity tracker": "准备商机追踪表",
  "Hold external replies for approval": "外部回复等待审批",
  "Observe product research workflow": "观察产品研究工作流",
  "Wait for assigned work": "等待分配工作",
  "Reconnect device": "重新连接设备",
  "Finish approval setup": "完成审批设置",
  "Start working": "开始工作",
  "Take control": "接管控制",
  "Command channels": "命令通道",
  "WeChat commands available": "微信命令可用",
  "Email commands configured": "邮件命令已配置",
  "Slack approval channel pending": "Slack 审批通道待配置",
  "Device assignment panel opened.": "已打开设备分配面板。",
  "Device health report exported.": "已导出设备状态报告。",
  "Human control requested.": "已请求人工接管。",
  "Sales AI Worker started work on this device.":
    "Sales AI Worker 已在此设备上开始工作。",
  Installable: "可安装",
  "Review needed": "需要检查",
  "Needs context": "需要上下文",
  Analyzing: "分析中",
  Captured: "已采集",
  "Detected workflow:": "识别到的工作流：",
  "Workflow apps": "工作流应用",
  "Analyze captured workflow": "分析已采集工作流",
  "Review workflows learned from recent training sessions":
    "检查最近训练会话中学习到的工作流",
  "Detected workflows": "识别到的工作流",
  "Latest training session": "最近训练会话",
  "Training session": "训练会话",
  "Pending decisions": "决策待确认",
  "Install to": "安装到",
  "Install workflow": "安装工作流",
  "Capture summary": "采集摘要",
  "Screen actions": "屏幕操作",
  "Visible text": "可见文字",
  "Captured context": "采集上下文",
  "Screen + Text + Voice": "屏幕 + 文字 + 语音",
  "Needs more context": "需要更多上下文",
  "Analyzing workflow evidence": "正在分析工作流证据",
  "Generating skill": "正在生成技能",
  "Generating variants": "正在生成变体",
  "Creating planner version": "正在创建规划器版本",
  "Running LLM task": "正在运行 LLM 任务",
  "Estimated progress": "预计进度",
  "See error details below.": "请查看下方错误详情。",
  Completed: "已完成",
  "Skill Builder Sections": "技能构建器分区",
  "No skill has been generated from the selected workflow yet.":
    "尚未从所选工作流生成技能。",
  "No variants have been generated yet.": "尚未生成变体。",
  "Agent optimization is waiting for a source skill.":
    "智能体优化正在等待源技能。",
  "Public access to agent optimization is coming soon.":
    "智能体优化公开入口即将开放。",
  "This feature optimizes a selected skill for different users' AI agents so execution becomes more accurate and smoother.":
    "此功能会面向不同用户的 AI 智能体优化所选技能，让执行更准确、更顺畅。",
  "Generate a skill first, then choose a source for future agent optimization.":
    "请先生成技能，再为未来的智能体优化选择来源。",
  "Choose either the skill or a generalized variant when agent optimization becomes available.":
    "智能体优化可用后，请选择技能或泛化变体作为来源。",
  "Generate the skill first, then come back when the variants preview is available.":
    "请先生成技能，等变体预览可用后再回来。",
  "Review the skill and keep it ready for future variants or agent optimization.":
    "检查技能，并为后续变体或智能体优化做好准备。",
  "Review the skill and wait for the public variants preview before trying again.":
    "检查技能，等待公开变体预览后再试。",
  "Review the variant that best fits the future scenario you care about.":
    "检查最适合你关注的未来场景的变体。",
  "What the skill gives you": "技能提供的内容",
  "What the variants stage produced": "变体阶段产物",
  "What changed in the agent-optimized version": "智能体优化版本的变化",
  "The skill is ready to review and can later feed both variants and agent optimization.":
    "技能已可检查，之后也可用于变体和智能体优化。",
  "The stage ran, but no reusable variants were persisted. Review the raw warnings before trusting the result.":
    "该阶段已运行，但没有保存可复用变体。在信任结果前请先检查原始警告。",
  "These variants reflect similar future AI tasks while preserving the habits learned from the current workflow.":
    "这些变体面向类似的未来 AI 任务，同时保留当前工作流中学到的习惯。",
  "The optimized result is tuned to help AI agents execute the workflow more accurately and more smoothly.":
    "优化结果用于帮助 AI 智能体更准确、更顺畅地执行工作流。",
  "Install this version when you want the saved skill folder to receive the agent-optimized draft.":
    "当你希望把智能体优化草稿写入已保存的技能文件夹时，安装这个版本。",
  "Preview Closed": "预览未开放",
  "Variant debug view": "变体调试视图",
  "Workflow debug view": "工作流调试视图",
  "Install debug view": "安装调试视图",
  "Skill Path": "技能路径",
  "Saved path:": "已保存路径：",
  "Config:": "配置：",
  Save: "保存",
  "Auto Detect": "自动检测",
  "Refresh Skills": "刷新技能",
  "Refreshing...": "刷新中...",
  "Install From Current Session": "从当前会话安装",
  "Install to Skill Folder": "安装到技能文件夹",
  "Installed Skills": "已安装技能",
  "Latest Install Result": "最新安装结果",
  "Install Name": "安装名称",
  Source: "来源",
  Steps: "步骤",
  "Skill File": "技能文件",
  "Install directory:": "安装目录：",
  Latest: "最新",
  Uninstall: "卸载",
  Copy: "复制",
  "Choose a detected skill folder": "选择检测到的技能文件夹",
  "Use This Folder": "使用此文件夹",
  Cancel: "取消",
  manual: "手动",
  generated: "生成",
  "Skill Name": "技能名称",
  "Short Description": "简短描述",
  Goal: "目标",
  Window: "窗口",
  Events: "事件",
  Edit: "编辑",
  Description: "描述",
  Reset: "重置",
  "Save Changes": "保存更改",
  "Edit Skill": "编辑技能",
  "When To Use": "适用场景",
  "When Not To Use": "不适用场景",
  Inputs: "输入",
  Outputs: "输出",
  Prerequisites: "前置条件",
  "Success Criteria": "成功标准",
  "Failure Modes": "失败模式",
  Fallbacks: "兜底方案",
  Examples: "示例",
  Assets: "素材",
  Tags: "标签",
  "Add Input": "添加输入",
  "Add Output": "添加输出",
  "Add Step": "添加步骤",
  Remove: "移除",
  Name: "名称",
  Required: "必填",
  Input: "输入",
  Output: "输出",
  Path: "路径",
  Overview: "概览",
  Debug: "调试",
  "View Mode": "视图模式",
  "Raw Artifacts and Diagnostics": "原始产物和诊断",
  "LLM Calls": "LLM 调用",
  "Total Tokens": "总 Token",
  "Input Tokens": "输入 Token",
  "Output Tokens": "输出 Token",
  "Reaction Time": "响应耗时",
  "No raw diagnostics are available for this stage yet.":
    "该阶段暂无原始诊断信息。",
  "No usage guidance was recorded for this skill.": "该技能暂无适用场景说明。",
  "No exclusion guidance was recorded for this skill.":
    "该技能暂无不适用场景说明。",
  "No explicit inputs were recorded for this skill.": "该技能暂无明确输入。",
  "No explicit outputs were recorded for this skill.": "该技能暂无明确输出。",
  "No prerequisites were recorded for this skill.": "该技能暂无前置条件。",
  "No success criteria were recorded for this skill.": "该技能暂无成功标准。",
  "No failure modes were recorded for this skill.": "该技能暂无失败模式。",
  "No fallback guidance was recorded for this skill.": "该技能暂无兜底说明。",
  "No examples were recorded for this skill.": "该技能暂无示例。",
  "No tags were recorded for this skill.": "该技能暂无标签。",
  "No inputs yet. Add one if needed.": "暂无输入，需要时可以添加。",
  "No outputs yet. Add one if needed.": "暂无输出，需要时可以添加。",
  "Use one item per line.": "每行填写一项。",
  "Use one item per line. Leave blank if none.": "每行填写一项；没有则留空。",
  "Leave blank if the name already says enough.":
    "如果名称已足够清楚，可留空。",
  "Add at least one When To Use item.": "请至少添加一个适用场景。",
  "Add at least one prerequisite.": "请至少添加一个前置条件。",
  "Add at least one step.": "请至少添加一个步骤。",
  "Add at least one success criterion.": "请至少添加一个成功标准。",
  "Skill Name is required.": "技能名称为必填。",
  "Goal is required.": "目标为必填。",
  "Description is required.": "描述为必填。",
  "Use a JSON string array or a JSON object with string values.":
    "请使用 JSON 字符串数组，或包含字符串值的 JSON 对象。",
  "Model settings saved.": "模型设置已保存。",
  "Recorder settings saved.": "录制设置已保存。",
  "Learning settings saved.": "学习设置已保存。",
  "Starting Learning Mode startup check...": "正在启动学习模式启动检查...",
  "Preparing Learning Mode dependency 1 of 4...": "正在准备学习模式依赖 1/4...",
  "Preparing Learning Mode dependency 2 of 4...": "正在准备学习模式依赖 2/4...",
  "Preparing Learning Mode dependency 3 of 4...": "正在准备学习模式依赖 3/4...",
  "Preparing Learning Mode dependency 4 of 4...": "正在准备学习模式依赖 4/4...",
  "Preparing Learning Mode dependencies (1/4)": "准备学习模式依赖 (1/4)",
  "Preparing Learning Mode dependencies (2/4)": "准备学习模式依赖 (2/4)",
  "Preparing Learning Mode dependencies (3/4)": "准备学习模式依赖 (3/4)",
  "Preparing Learning Mode dependencies (4/4)": "准备学习模式依赖 (4/4)",
  "Starting Learning Mode...": "正在启动学习模式...",
  "Starting Learning Mode": "启动学习模式",
  "Waiting for Learning Mode health check to succeed...":
    "正在等待学习模式健康检查通过...",
  "Running Learning Mode health check": "正在运行学习模式健康检查",
  "Learning Mode is ready.": "学习模式已就绪。",
  "Learning Mode preparation did not finish. Review the message below and try again.":
    "学习模式准备未完成。请查看下方信息并重试。",
  "Learning Mode preparation starts after all required permissions are granted.":
    "所有必需权限授予后，学习模式会开始准备。",
  "Waiting to prepare Learning Mode": "等待准备学习模式",
  "Language settings saved.": "语言设置已保存。",
  "Skill path saved.": "技能路径已保存。",
  "Skill Path is required before saving.": "保存前必须填写技能路径。",
  "No installed skills found in the current Skill Path.":
    "当前技能路径中未找到已安装技能。",
  "Select a session from the left first.": "请先从左侧选择一个会话。",
  "Set a skill folder, install results from this session, and manage installed skills":
    "设置技能文件夹，安装本会话结果，并管理已安装技能",
  "Choose where exported skills should be stored": "选择导出技能的保存位置",
  "Install any base, variant, or agent-optimized result you can review here":
    "安装这里可检查的基础、变体或智能体优化结果",
  "Save a Skill Path before installing results from the current session.":
    "安装当前会话结果前，请先保存技能路径。",
  "Save a Skill Path first. Installed skills will be written to that folder.":
    "请先保存技能路径。已安装技能会写入该文件夹。",
  "This session does not have installable results yet. Generate a skill, a variant, or an agent-optimized result first.":
    "此会话暂时没有可安装结果。请先生成技能、变体或智能体优化结果。",
  "Manage the skills currently available in this folder":
    "管理当前文件夹中可用的技能",
  "No installed skills were detected yet. Save a Skill Path and install a result from the current session to populate this list.":
    "尚未检测到已安装技能。请保存技能路径，并从当前会话安装一个结果来填充列表。",
  "Select a detected folder to fill the Skill Path field. Nothing is saved until you press Save.":
    "选择检测到的文件夹来填充技能路径字段。点击“保存”前不会写入任何内容。",
  "Inspect the latest exported skill package.": "检查最新导出的技能包。",
  "Install Dir": "安装目录",
  "install directory": "安装目录",
  "skill file": "技能文件",
  "source skill": "来源技能",
  "install result.json": "安装结果 JSON",
  "Note: AI agents may not always follow the workflow logic captured in this skill on their own. Using this prompt can improve the experience:":
    "注意：AI 智能体不一定会主动遵循此技能捕获的工作流逻辑。使用这段提示词可以改善体验：",
  Ready: "就绪",
  Preparing: "准备中",
  Missing: "缺失",
  Pending: "等待中",
  Granted: "已授权",
  "Request Permission": "请求权限",
  "Requesting...": "请求中...",
  "Refresh Status": "刷新状态",
  "Screen Recording": "屏幕录制",
  Accessibility: "辅助功能",
  "Input Monitoring": "输入监控",
  Microphone: "麦克风",
  "Lets OysterWorkflow read screen content so it can capture steps and visible text.":
    "允许 OysterWorkflow 读取屏幕内容，以采集步骤和可见文字。",
  "Lets OysterWorkflow notice app switches and UI changes while you work.":
    "允许 OysterWorkflow 在你操作时感知应用切换和 UI 变化。",
  "Lets OysterWorkflow capture keyboard and pointer activity so recorded steps stay in sync.":
    "允许 OysterWorkflow 采集键盘和指针活动，让录制步骤保持同步。",
  "Lets OysterWorkflow capture spoken narration so it can transcribe your workflow commentary.":
    "允许 OysterWorkflow 采集语音旁白，以转写你的工作流说明。",
  "We have not confirmed this permission yet.": "尚未确认此权限。",
  "All required recorder permissions are granted. Continue to the recorder setup step.":
    "所有必需录制器权限均已授予。继续进入录制器设置步骤。",
  "All required Learning Mode permissions are granted. Continue to setup.":
    "所有必需学习模式权限均已授予。继续设置。",
  "Grant the required recorder permissions before continuing to recorder setup.":
    "继续进入录制器设置前，请先授予必需的录制器权限。",
  "Grant the required Learning Mode permissions before continuing.":
    "继续之前，请先授予必需的学习模式权限。",
  "Grant the required macOS permissions before continuing to recorder setup.":
    "继续进入录制器设置前，请先授予必需的 macOS 权限。",
  "Grant recorder permissions before entering OysterWorkflow":
    "进入 OysterWorkflow 前请授予录制器权限",
  "Grant Learning Mode permissions before entering OysterWorkflow":
    "进入 OysterWorkflow 前请授予学习模式权限",
  "Continue to Prepare Recorder": "继续准备录制器",
  "Continue to Prepare Learning Mode": "继续准备学习模式",
  "Prepare recorder before entering OysterWorkflow":
    "进入 OysterWorkflow 前准备录制器",
  "Prepare Learning Mode before entering OysterWorkflow":
    "进入 OysterWorkflow 前准备学习模式",
  "Recorder Preparation": "录制器准备",
  "Learning Mode Preparation": "学习模式准备",
  "OysterWorkflow installs recorder dependencies and waits for the recorder health check before recording can start.":
    "OysterWorkflow 会安装录制器依赖，并等待录制器健康检查通过后再开始录制。",
  "OysterWorkflow prepares the local learning service and waits for the health check before training can start.":
    "OysterWorkflow 会准备本地学习服务，并等待健康检查通过后再开始训练。",
  "Recorder preparation progress": "录制器准备进度",
  "Learning Mode preparation progress": "学习模式准备进度",
  "Retry Recorder Preparation": "重试录制器准备",
  "Retry Learning Mode Preparation": "重试学习模式准备",
  "Advanced Reasoning Effort": "高级推理强度",
  "Advanced Timeout Config": "高级超时配置",
  Provider: "服务商",
  "Base URL": "Base URL",
  "Wire API": "接口协议",
  Custom: "自定义",
  default: "默认",
  "Customized reasoning effort for each call": "为每次调用单独设置推理强度",
  "Global Reasoning Effort": "全局推理强度",
  "Timeout Config": "超时配置",
  "Auth Mode": "认证模式",
  "Client Profile": "客户端画像",
  "API Key": "API Key",
  "API Key Variable Name": "API Key 变量名",
  "Custom Provider": "自定义服务商",
  "Custom Model": "自定义模型",
  "Waiting Strategy": "等待策略",
  "This does not affect actual requests. It is only used as your LLM provider label.":
    "这不会影响实际请求，只用作你的 LLM 服务商标签。",
  "As long as the model keeps streaming output, do not timeout":
    "只要模型持续流式输出，就不超时",
  "Request starts counting immediately (180s timeout)":
    "请求开始后立即计时（180 秒超时）",
  "Apply advanced timeout config": "应用高级超时配置",
  "Please use default.": "请使用默认值。",
  "Direct API Key": "直接 API Key",
  "Environment Variable": "环境变量",
  "No API Key": "无 API Key",
  "Leave blank to keep the current key": "留空以保留当前密钥",
  "A direct API key is already stored. Leave API Key blank if you do not want to change it.":
    "已保存直接 API Key。如果不想修改，请将 API Key 留空。",
  Advanced: "高级",
  "Tune the waiting strategy and optional per-stage timeouts for workflow and skill generation.":
    "调整工作流与技能生成的等待策略，以及可选的分阶段超时。",
  "While the model keeps streaming output, continue waiting":
    "模型持续流式输出时继续等待",
  "Start the timeout when the request begins": "请求开始时启动超时计时",
  "Leave blank to use the shared timeout": "留空以使用共享超时",
  "Override the shared reasoning effort for specific workflow and skill-generation stages when you need finer control.":
    "需要更精细控制时，可为特定工作流与技能生成阶段覆盖共享推理强度。",
  "Inherit global reasoning effort": "继承全局推理强度",
  "Skill Extract": "技能提取",
  "Planner Version": "规划器版本",
  "Variant Prediction": "变体预测",
  "Variant Generation": "变体生成",
  "Global Timeout (ms)": "全局超时（毫秒）",
  "Find Workflows Timeout (ms)": "查找工作流超时（毫秒）",
  "Find Workflows Reasoning": "查找工作流推理强度",
  "Skill Extract Reasoning": "技能提取推理强度",
  "Open Advanced Reasoning Effort": "打开高级推理强度",
  "Open Advanced Timeout Config": "打开高级超时配置",
  "Save Model Settings": "保存模型设置",
  "Retry LLM Config": "重试 LLM 配置",
  "Load LLM Config": "加载 LLM 配置",
  "Choose the model OysterWorkflow uses for workflow and skill generation":
    "选择 OysterWorkflow 用于工作流与技能生成的模型",
  "Loading LLM settings before workflow and skill actions become available.":
    "正在加载 LLM 设置，完成后才能使用工作流和技能操作。",
  "LLM settings could not be loaded. Please configure LLM in Settings > Model first.":
    "无法加载 LLM 设置。请先在“设置 > 模型”中配置 LLM。",
  "Please configure LLM in Settings > Model before running workflow or skill generation.":
    "运行工作流或技能生成前，请先在“设置 > 模型”中配置 LLM。",
  "Display Language": "显示语言",
  "Save General Settings": "保存通用设置",
  "Message routing": "消息路由",
  "Message channels": "消息渠道",
  "Connect a message channel": "连接消息渠道",
  "Link an account first. You will choose the conversation and AI worker session after it is verified.":
    "先连接账号。验证成功后，再选择要绑定的对话和 AI Worker 会话。",
  Connect: "连接",
  Verify: "验证",
  Bind: "绑定",
  "Choose where messages arrive": "选择消息来源",
  "Each account stays on this computer. Connecting it does not bind every conversation to the worker.":
    "每个账号都保留在这台电脑上。连接账号不会把所有对话自动绑定给 Worker。",
  "Set up later": "稍后设置",
  "Skip for now. You can connect one later.": "暂时跳过，之后可以随时连接。",
  "Scan from WhatsApp Linked Devices.": "从 WhatsApp 的“已关联设备”扫码。",
  "Connect a WeChat iLink bot.": "连接微信 iLink Bot。",
  "Use your workspace's Socket Mode app.": "使用工作区的 Socket Mode App。",
  "Use a BotFather bot token.": "使用 BotFather 创建的 Bot Token。",
  "WeChat connects an iLink bot identity. It does not sign in to or control your personal WeChat account.":
    "微信渠道连接的是 iLink Bot 身份，不会登录或控制你的个人微信账号。",
  "Connection code unavailable": "连接码不可用",
  "Waiting for phone confirmation": "等待手机确认",
  "Ready to scan": "可以扫码",
  "Preparing secure connector": "正在准备安全连接组件",
  "Creating a secure code": "正在创建安全连接码",
  "Could not create a connection code": "无法创建连接码",
  "Preparing secure connection": "正在准备安全连接",
  "The code is temporary. Credentials remain on this computer, and OysterWorkflow stores only connection status.":
    "连接码为临时凭据。账号凭据保留在本机，OysterWorkflow 只保存连接状态。",
  "Trying again...": "正在重试...",
  "Try again": "重试",
  "The QR image could not be rendered.": "二维码图片无法显示。",
  "Render again": "重新生成图片",
  "Channel pairing QR": "渠道配对二维码",
  "Preparing QR code": "正在准备二维码",
  "Choose a channel": "选择渠道",
  Back: "返回",
  Continue: "继续",
  Done: "完成",
  "No worker assigned": "尚未分配 AI Worker",
  "Open the assigned AI worker to manage its message channel.":
    "打开已分配的 AI Worker 管理消息渠道。",
  "Assign an AI worker before configuring message routing on this computer.":
    "先分配 AI Worker，再配置这台电脑上的消息路由。",
  "Choose the app display language": "选择应用显示语言",
  "Switch the main interface and settings between English and Chinese.":
    "在英文和中文之间切换主界面与设置页展示。",
  "Share publicly on ClawHub": "公开分享到 ClawHub",
  "Publish this workflow as a free OpenClaw skill and get a link anyone can share.":
    "将此工作流发布为免费的 OpenClaw 技能，并生成任何人都能分享的链接。",
  "Connect ClawHub to publish": "连接 ClawHub 后发布",
  "Authorization opens in your browser. Your friends do not need an account to view the public page.":
    "授权页面会在浏览器中打开。朋友查看公开页面时不需要账号。",
  "Connect ClawHub": "连接 ClawHub",
  "Waiting for authorization...": "等待授权...",
  "Authorization code": "授权码",
  "Open authorization page": "打开授权页面",
  "I understand that publishing makes this skill public under MIT-0. Anyone may use, modify, and redistribute it without attribution.":
    "我了解发布后此技能将以 MIT-0 公开，任何人都可以使用、修改和再分发，且无需署名。",
  "Generate this workflow before publishing it.":
    "请先生成此工作流，再进行发布。",
  "Publishing to ClawHub...": "正在发布到 ClawHub...",
  "Publish publicly": "公开发布",
  "Ready to share": "可以分享",
  "Open listing": "打开详情页",
  "Share link": "分享链接",
  "Copy link": "复制链接",
  Copied: "已复制",
  "OpenClaw install command": "OpenClaw 安装命令",
  "Copy command": "复制命令",
  "This publishes only the generated skill. Recorded screens, OCR, account credentials, and local sessions are not uploaded.":
    "这里只会发布生成的技能，不会上传录屏、OCR、账号凭据或本地会话。",
  English: "英文",
};

const ZH_PATTERNS: Array<{
  pattern: RegExp;
  replace: (...matches: string[]) => string;
}> = [
  {
    pattern: /^Version (.+) is already public\.$/u,
    replace: (_match, version) => `版本 ${version} 已公开。`,
  },
  {
    pattern: /^Version (.+) is now public\.$/u,
    replace: (_match, version) => `版本 ${version} 现已公开。`,
  },
  {
    pattern: /^Selected workflow: (.+)$/u,
    replace: (_match, workflow) => `所选工作流：${workflow}`,
  },
  {
    pattern: /^Manage (.+)$/u,
    replace: (_match, channel) => `管理 ${channel}`,
  },
  {
    pattern: /^Disconnect (.+) before choosing another app\.$/u,
    replace: (_match, channel) => `请先断开 ${channel}，再选择另一个 App。`,
  },
  {
    pattern: /^Keep this (.+) app and bind a different conversation\.$/u,
    replace: (_match, channel) => `保留当前 ${channel} App，并绑定另一个会话。`,
  },
  {
    pattern: /^Disconnect (.+) and choose another message app\.$/u,
    replace: (_match, channel) => `断开 ${channel}，并选择另一个消息 App。`,
  },
  {
    pattern: /^Switch away from (.+)\?$/u,
    replace: (_match, channel) => `要从 ${channel} 切换吗？`,
  },
  {
    pattern:
      /^(.+) will be disconnected from this AI worker\. Existing message routing will stop until another app is connected and bound\.$/u,
    replace: (_match, channel) =>
      `${channel} 将与此 AI Worker 断开。连接并绑定另一个 App 前，现有消息路由会停止。`,
  },
  {
    pattern: /^Disconnect (.+)$/u,
    replace: (_match, channel) => `断开 ${channel}`,
  },
  {
    pattern: /^This account is connected and bound to (.+)\.$/u,
    replace: (_match, workerName) => `此账号已连接并绑定到 ${workerName}。`,
  },
  {
    pattern:
      /^New messages in the bound conversation resume AI worker session (.+)\.$/u,
    replace: (_match, sessionId) =>
      `绑定会话中的新消息将继续运行 AI Worker 会话 ${sessionId}。`,
  },
  {
    pattern:
      /^Access approved for (.+)\. Send one new message, then refresh\.$/u,
    replace: (_match, userName) =>
      `已批准 ${userName} 的访问权限。请发送一条新消息，然后刷新。`,
  },
  {
    pattern: /^Managed by (.+)$/,
    replace: (_match, workerName) => `由 ${workerName} 管理`,
  },
  {
    pattern:
      /^Captured (\d+) raw UI events?, (\d+) OCR entries?, and (\d+) audio entries? across (\d+) episodes?\.$/,
    replace: (_match, ui, ocr, audio, episodes) =>
      `采集到 ${ui} 条原始 UI 事件、${ocr} 条 OCR 记录和 ${audio} 条音频记录，共 ${episodes} 个片段。`,
  },
  {
    pattern:
      /^Ingest completed with (\d+) warnings?\. The data is still usable, but it deserves a quick review before you trust later stages\.$/,
    replace: (_match, count) =>
      `处理完成，但有 ${count} 条警告。数据仍可使用，不过在信任后续阶段前建议快速检查。`,
  },
  {
    pattern:
      /^Ingest completed with no warnings\. The data is ready for workflow discovery\.$/,
    replace: () => "处理完成且没有警告。数据已可用于发现工作流。",
  },
  {
    pattern:
      /^Ingest finished, but the recorder did not capture any raw UI or OCR evidence, so downstream extraction will not be trustworthy yet\.(.*)$/,
    replace: (_match, audioNote) =>
      `采集处理已完成，但录制器没有捕获任何原始 UI 或 OCR 证据，因此后续提取暂时不可靠。${translatePlainText(audioNote, "zh")}`,
  },
  {
    pattern:
      /^Audio was disabled for this recording, so no raw audio was expected\.$/,
    replace: () => "本次录制已关闭音频，因此预期不会有原始音频。",
  },
  {
    pattern: /^Found (\d+) candidate workflows? in the current trace\.$/,
    replace: (_match, count) => `当前轨迹中找到 ${count} 个候选工作流。`,
  },
  {
    pattern:
      /^The current selection is "([^"]+)"\. Use it when this card best represents the successful path you want to extract\.$/,
    replace: (_match, name) =>
      `当前选择是“${name}”。当这张卡片最能代表你想提取的成功路径时使用它。`,
  },
  {
    pattern: /^When you're ready, open Skill and generate from "([^"]+)"\.$/,
    replace: (_match, name) => `准备好后，打开“技能”并从“${name}”生成。`,
  },
  {
    pattern: /^Built a skill with (\d+) steps? from (\d+) source events?\.$/,
    replace: (_match, steps, events) =>
      `已基于 ${events} 条来源事件构建出包含 ${steps} 个步骤的技能。`,
  },
  {
    pattern:
      /^The draft is usable, but (\d+) warnings? mean it should be reviewed before you generalize or install it\.$/,
    replace: (_match, count) =>
      `草稿可用，但有 ${count} 条警告；在泛化或安装前应先检查。`,
  },
  {
    pattern:
      /^Generated (\d+) reusable variants? from (\d+) predicted scenarios?\.$/,
    replace: (_match, variants, scenarios) =>
      `已从 ${scenarios} 个预测场景生成 ${variants} 个可复用变体。`,
  },
  {
    pattern:
      /^Variants were created, but (\d+) warnings? may affect which one you should trust\.$/,
    replace: (_match, count) =>
      `变体已创建，但 ${count} 条警告可能影响你应该信任哪一个。`,
  },
  {
    pattern: /^Agent optimization is coming soon for "([^"]+)"\.$/,
    replace: (_match, label) => `“${label}”的智能体优化即将开放。`,
  },
  {
    pattern:
      /^Created an agent-optimized skill from the (selected skill|selected generalized variant)\.$/,
    replace: (_match, source) =>
      `已基于${source === "selected skill" ? "所选技能" : "所选泛化变体"}创建智能体优化技能。`,
  },
  {
    pattern:
      /^The optimized skill exists, but (\d+) warnings? suggest a technical review before installation\.$/,
    replace: (_match, count) =>
      `优化后的技能已生成，但 ${count} 条警告提示安装前应先做技术检查。`,
  },
  {
    pattern: /^Next:  ?(.+)$/,
    replace: (_match, next) => `下一步：${translatePlainText(next, "zh")}`,
  },
  {
    pattern: /^Processing: ?(.+)$/,
    replace: (_match, action) => `处理中：${action}`,
  },
  {
    pattern: /^Delete session (.+)$/,
    replace: (_match, label) => `删除会话 ${label}`,
  },
  {
    pattern: /^Delete workflow (.+)$/,
    replace: (_match, label) => `删除工作流 ${label}`,
  },
  {
    pattern: /^(.+) deleted\.$/,
    replace: (_match, label) => `${label} 已删除。`,
  },
  {
    pattern: /^(.+) \| ready$/,
    replace: (_match, prefix) => `${prefix} | 就绪`,
  },
  {
    pattern: /^(.+) \| recording$/,
    replace: (_match, prefix) => `${prefix} | 录制中`,
  },
  {
    pattern: /^(.+) \| failed$/,
    replace: (_match, prefix) => `${prefix} | 失败`,
  },
  {
    pattern: /^Input (\d+)$/,
    replace: (_match, index) => `输入 ${index}`,
  },
  {
    pattern: /^Output (\d+)$/,
    replace: (_match, index) => `输出 ${index}`,
  },
  {
    pattern: /^\(priority (\d+)\)$/,
    replace: (_match, priority) => `（优先级 ${priority}）`,
  },
  {
    pattern: /^Step (\d+)$/,
    replace: (_match, index) => `步骤 ${index}`,
  },
  {
    pattern: /^View (.+)$/,
    replace: (_match, label) => `查看 ${preserveTechnicalLabel(label)}`,
  },
  {
    pattern: /^Run (.+)$/,
    replace: (_match, label) => `执行 ${preserveTechnicalLabel(label)}`,
  },
  {
    pattern: /^Pause (.+)$/,
    replace: (_match, label) => `暂停 ${preserveTechnicalLabel(label)}`,
  },
  {
    pattern: /^Resume (.+)$/,
    replace: (_match, label) => `继续 ${preserveTechnicalLabel(label)}`,
  },
  {
    pattern: /^Enable (.+) before running$/,
    replace: (_match, label) =>
      `请先启用 ${preserveTechnicalLabel(label)}，再执行`,
  },
  {
    pattern: /^Start AI worker before running (.+)$/,
    replace: (_match, label) =>
      `请先启动 AI Worker，再执行 ${preserveTechnicalLabel(label)}`,
  },
  {
    pattern: /^AI worker started executing (.+)\.$/,
    replace: (_match, workflow) =>
      `AI Worker 已开始执行 ${preserveTechnicalLabel(workflow)}。`,
  },
  {
    pattern: /^(.+) actions$/,
    replace: (_match, label) => `${preserveTechnicalLabel(label)} 操作`,
  },
  {
    pattern: /^Detected (.+)\.$/,
    replace: (_match, label) => `已检测到 ${label}。`,
  },
  {
    pattern: /^Installed (.+)\.$/,
    replace: (_match, label) => `已安装 ${label}。`,
  },
  {
    pattern: /^(.+) installed to (.+)\.$/,
    replace: (_match, workflow, worker) => `${workflow} 已安装到 ${worker}。`,
  },
  {
    pattern: /^(.+) deployed to (.+)\.$/,
    replace: (_match, workflow, worker) => `${workflow} 已部署到 ${worker}。`,
  },
  {
    pattern: /^(.+) deployed$/,
    replace: (_match, workflow) => `${workflow} 已部署`,
  },
  {
    pattern:
      /^(.+) has installed workflows available\. Use Run on a workflow when you want it to execute\.$/,
    replace: (_match, worker) =>
      `${worker} 已有可用的工作流。需要执行时，请在某个工作流上点击“运行”。`,
  },
  {
    pattern:
      /^(.+) started\. I am checking the inbound queue and available command channels\.$/,
    replace: (_match, workflow) =>
      `${workflow} 已开始。我正在检查入站队列和可用命令通道。`,
  },
  {
    pattern:
      /^(.+) is assigned\. I can start once a workflow is installed and approvals stay in place\.$/,
    replace: (_match, device) =>
      `${device} 已分配。安装工作流且审批策略保持有效后，我就可以开始。`,
  },
  {
    pattern: /^Message (.+)\.\.\.$/,
    replace: (_match, name) => `给 ${name} 发消息...`,
  },
  {
    pattern: /^Message (.+)$/,
    replace: (_match, name) => `给 ${name} 发消息`,
  },
  {
    pattern: /^Step (\d+) of (\d+)$/,
    replace: (_match, current, total) => `第 ${current}/${total} 步`,
  },
  {
    pattern: /^(\d+) screen actions$/,
    replace: (_match, count) => `${count} 个屏幕动作`,
  },
  {
    pattern: /^(\d+) decisions$/,
    replace: (_match, count) => `${count} 个决策`,
  },
  {
    pattern: /^Prompt copied for (.+)\.$/,
    replace: (_match, label) => `已复制 ${label} 的提示词。`,
  },
  {
    pattern: /^Latest install highlighted below: ?(.+)$/,
    replace: (_match, label) => `最新安装已在下方高亮：${label}`,
  },
  {
    pattern:
      /^Installed ([^,]+), but it was not found in the refreshed Installed Skills list\. Check the current Skill Path and try Refresh Skills again\.$/,
    replace: (_match, name) =>
      `已安装 ${name}，但刷新后的已安装技能列表中未找到它。请检查当前技能路径，并再次尝试刷新技能。`,
  },
  {
    pattern:
      /^(low|medium|high|xhigh) reasoning · (\d+) events?(?: · (\d+) steps?)?$/,
    replace: (_match, tier, events, steps) =>
      `${formatReasoningTierForZh(tier)}推理 · ${events} 个事件${steps ? ` · ${steps} 个步骤` : ""}`,
  },
  {
    pattern: /^(low|medium|high|xhigh) reasoning · default estimate$/,
    replace: (_match, tier) =>
      `${formatReasoningTierForZh(tier)}推理 · 默认估算`,
  },
  {
    pattern:
      /^Please configure LLM first\. ([A-Z0-9_]+) is not available in the current environment\.$/,
    replace: (_match, envName) =>
      `请先配置 LLM。当前环境中没有可用的 ${envName}。`,
  },
  {
    pattern: /^(.+) Timeout \(ms\)$/,
    replace: (_match, label) =>
      `${translatePlainText(label, "zh")}超时（毫秒）`,
  },
  {
    pattern: /^(.+) Reasoning$/,
    replace: (_match, label) => `${translatePlainText(label, "zh")}推理强度`,
  },
  {
    pattern: /^The latest LLM config refresh failed: ([\s\S]+)$/,
    replace: (_match, error) => `最新 LLM 配置刷新失败：${error}`,
  },
  {
    pattern:
      /^The local OysterWorkflow service could not complete the request \(HTTP (\d+)\)\.$/,
    replace: (_match, status) =>
      `本地 OysterWorkflow 服务未能完成请求（HTTP ${status}）。`,
  },
  {
    pattern: /^Failed to load the LLM config: ([\s\S]+)$/,
    replace: (_match, error) => `加载 LLM 配置失败：${error}`,
  },
  {
    pattern:
      /^Note: AI agents may not always follow the workflow logic captured in this skill on their own\. Using this prompt can improve the experience: Use the installed skill "([^"]+)" as the primary guide for this task\.[\s\S]*$/,
    replace: (_match, skillName) =>
      `注意：AI 智能体不一定会主动遵循此技能捕获的工作流逻辑。使用这段提示词可以改善体验：请把已安装技能“${skillName}”作为此任务的主要指南。开始行动前，请阅读并遵循该技能的步骤。按照技能预期的工作流和决策逻辑执行任务。你不需要逐字复制表面操作，但应保留相同的含义、逻辑、检查和结果，除非我明确要求改变。`,
  },
];

const SKIP_TEXT_SELECTOR = "script, style, textarea, input, pre, code";
const SKIP_WALKER_SUBTREE_SELECTOR = "script, style, pre, code";

/**
 * EN: Applies display-language localization to static UI text that still comes from legacy hard-coded labels.
 * 中文: 对仍来自历史硬编码标签的静态 UI 文案应用显示语言本地化。
 * @param root DOM subtree to localize.
 * @param language active display language.
 * @returns cleanup callback that disconnects the observer.
 */
export function applyUiLocalization(
  root: ParentNode,
  language: AppLanguage,
): () => void {
  localizeNode(root, language);

  if (typeof MutationObserver === "undefined") {
    return () => undefined;
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        localizeTextNode(mutation.target as Text, language);
        continue;
      }
      for (const node of mutation.addedNodes) {
        localizeNode(node, language);
      }
      if (mutation.target instanceof Element) {
        localizeElementAttributes(mutation.target, language);
      }
    }
  });

  observer.observe(root, {
    attributes: true,
    attributeFilter: [...TRANSLATABLE_ATTRIBUTES],
    childList: true,
    characterData: true,
    subtree: true,
  });

  return () => {
    observer.disconnect();
  };
}

function localizeNode(node: Node | ParentNode, language: AppLanguage): void {
  if (node instanceof Text) {
    localizeTextNode(node, language);
    return;
  }

  if (!(node instanceof Element || node instanceof DocumentFragment)) {
    return;
  }

  if (node instanceof Element) {
    localizeElementAttributes(node, language);
  }

  const walker = document.createTreeWalker(
    node,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(candidate) {
        if (
          candidate instanceof Element &&
          candidate.matches(SKIP_WALKER_SUBTREE_SELECTOR)
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  let current = walker.nextNode();
  while (current) {
    if (current instanceof Text) {
      localizeTextNode(current, language);
    } else if (current instanceof Element) {
      localizeElementAttributes(current, language);
    }
    current = walker.nextNode();
  }
}

function localizeTextNode(node: Text, language: AppLanguage): void {
  if (node.parentElement?.closest(SKIP_TEXT_SELECTOR)) {
    return;
  }

  const original = getOriginalText(node);
  const next = translatePlainText(original, language);
  if (node.nodeValue !== next) {
    node.nodeValue = next;
  }
}

function localizeElementAttributes(
  element: Element,
  language: AppLanguage,
): void {
  for (const attribute of TRANSLATABLE_ATTRIBUTES) {
    const current = element.getAttribute(attribute);
    if (current === null || current.trim().length === 0) {
      continue;
    }

    const original = getOriginalAttribute(element, attribute, current);
    const next = translatePlainText(original, language);
    if (current !== next) {
      element.setAttribute(attribute, next);
    }
  }
}

function getOriginalText(node: Text): string {
  const known = TEXT_NODE_ORIGINALS.get(node);
  if (known !== undefined) {
    const current = node.nodeValue ?? "";
    if (!isKnownLanguageRendering(known, current)) {
      TEXT_NODE_ORIGINALS.set(node, current);
      return current;
    }
    return known;
  }

  const original = node.nodeValue ?? "";
  TEXT_NODE_ORIGINALS.set(node, original);
  return original;
}

function getOriginalAttribute(
  element: Element,
  attribute: string,
  current: string,
): string {
  let attributes = ELEMENT_ATTRIBUTE_ORIGINALS.get(element);
  if (!attributes) {
    attributes = new Map<string, string>();
    ELEMENT_ATTRIBUTE_ORIGINALS.set(element, attributes);
  }

  const known = attributes.get(attribute);
  if (known !== undefined) {
    if (!isKnownLanguageRendering(known, current)) {
      attributes.set(attribute, current);
      return current;
    }
    return known;
  }

  attributes.set(attribute, current);
  return current;
}

function translatePlainText(value: string, language: AppLanguage): string {
  if (language !== "zh") {
    return value;
  }

  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }

  const exact = ZH_TEXT[trimmed];
  if (exact) {
    return `${leading}${exact}${trailing}`;
  }

  for (const item of ZH_PATTERNS) {
    const match = trimmed.match(item.pattern);
    if (match) {
      return `${leading}${item.replace(...match)}${trailing}`;
    }
  }

  return value;
}

function isKnownLanguageRendering(original: string, current: string): boolean {
  return APP_LANGUAGES.some(
    (language) => current === translatePlainText(original, language),
  );
}

function preserveTechnicalLabel(value: string): string {
  return value;
}

function formatReasoningTierForZh(value: string): string {
  switch (value) {
    case "low":
      return "低强度";
    case "high":
      return "高强度";
    case "xhigh":
      return "超高强度";
    case "medium":
    default:
      return "中等强度";
  }
}
