import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  LAB_LLM_CALL_PROFILE_KEYS,
  LAB_SCREENPIPE_LANGUAGES,
  RECORDER_LANGUAGE_PRIORITY_SLOT_COUNT,
} from "../../src/lab-api/api-contracts.js";
import {
  APP_LANGUAGE_OPTIONS,
  formatAppLanguageLabel,
  type AppLanguage,
} from "./app-language";
import { formatChromeCapabilityDetail } from "./chrome-capability-presentation";
import type {
  LabLlmCallProfileKey,
  LabLlmResponseTimeoutMode,
  LabScreenpipeLanguage,
  RecorderPermissionItem,
  RecorderPermissionKind,
  RecorderPermissionsResponse,
} from "../../src/lab-api/api-contracts.js";
import type {
  ProductCapabilityProvider,
  ProductCapabilityProviderId,
} from "../../src/product/contracts.js";
import type {
  DesktopUpdateErrorCode,
  DesktopUpdatePhase,
  DesktopUpdateSnapshot,
} from "../../src/desktop-update/contracts.js";
import {
  LLM_CLIENT_PROFILE_OPTIONS,
  LLM_CUSTOMIZED_REASONING_OPTION,
  LLM_SIMPLE_TIMEOUT_MS,
  LLM_MODEL_PRESET_OPTIONS,
  LLM_PROVIDER_PRESET_OPTIONS,
  LLM_REASONING_EFFORT_OPTIONS,
  detectLlmModelPreset,
  parseResponseReadTimeoutMs,
  resolveLlmModelValue,
  resolveLlmTimeoutConfigOption,
  type LlmCallProfileFormState,
  type LlmFormState,
  type LlmGlobalReasoningOption,
  type LlmTimeoutConfigOption,
} from "./llm-settings";
import { ComposioConnections } from "./composio-connections";
import type {
  StartupDependencyId,
  StartupRuntimePreparationStatus,
} from "./startup-runtime-preparation";
import { handleScrollableRegionKeyDown } from "./scroll-region";
import { useTopmostModal } from "./modal-focus";

export type SettingsSection =
  "general" | "updates" | "recorder" | "permissions" | "applications" | "llm";
export type PermissionsModalMode = "manual" | "blocking";
export type RecorderLanguageSlotValue = LabScreenpipeLanguage | "";

type VisibleLlmCallProfileKey = Exclude<
  LabLlmCallProfileKey,
  "planner-optimization"
>;

const LLM_CALL_PROFILE_LABELS: Record<
  VisibleLlmCallProfileKey,
  { en: string; zh: string }
> = {
  "workflow-discovery": { en: "Find Workflows", zh: "发现工作流" },
  "skill-extraction-step": { en: "Extract Skill Step", zh: "提取技能步骤" },
  "skill-extraction-terminal": {
    en: "Complete Skill Extraction",
    zh: "完成技能提取",
  },
  "skill-extraction-finalize": { en: "Finalize Skill", zh: "定稿技能" },
  "workflow-candidate-generation": {
    en: "Generate Workflow Candidates",
    zh: "生成工作流候选",
  },
  "workflow-family-matching": {
    en: "Match Workflow Family",
    zh: "匹配工作流家族",
  },
  "workflow-merge-proposal": {
    en: "Propose Workflow Merge",
    zh: "提出工作流合并",
  },
  "scenario-prediction": { en: "Predict Variants", zh: "预测场景变体" },
  "scenario-generalization": {
    en: "Generate Variants",
    zh: "生成场景变体",
  },
  "harness-planning": { en: "Plan Harness", zh: "规划 Harness" },
  "harness-generation": { en: "Generate Harness", zh: "生成 Harness" },
};

const VISIBLE_LLM_CALL_PROFILE_KEYS = LAB_LLM_CALL_PROFILE_KEYS.filter(
  (key): key is VisibleLlmCallProfileKey => key !== "planner-optimization",
);

export const LLM_CALL_PROFILE_FIELDS: Array<{
  key: LabLlmCallProfileKey;
  label: { en: string; zh: string };
}> = VISIBLE_LLM_CALL_PROFILE_KEYS.map((key) => ({
  key,
  label: LLM_CALL_PROFILE_LABELS[key],
}));

export function clearAdvancedLlmProfileOverrides(
  field: keyof LlmCallProfileFormState,
  update: (
    key: LabLlmCallProfileKey,
    field: keyof LlmCallProfileFormState,
    value: string,
  ) => void,
): void {
  LAB_LLM_CALL_PROFILE_KEYS.forEach((key) => update(key, field, ""));
}

const SETTINGS_COPY: Record<
  AppLanguage,
  {
    modalEyebrow: string;
    modalTitle: string;
    closeLabel: string;
    sectionsAriaLabel: string;
    sections: Record<SettingsSection, string>;
    general: {
      eyebrow: string;
      title: string;
      note: string;
      windowsChineseInputNote: string;
      languageLabel: string;
      languageAriaLabel: string;
      saveLabel: string;
    };
    recorder: {
      eyebrow: string;
      title: string;
      note: string;
      priorityLabel: (index: number) => string;
      priorityAriaLabel: (index: number) => string;
      notSetLabel: string;
      audioLabel: string;
      audioToggleLabel: string;
      audioTitle: string;
      audioDescription: string;
      resetLabel: string;
      saveLabel: string;
    };
    permissions: {
      eyebrow: string;
      title: string;
      checkingSummary: string;
      fallbackSummary: string;
      blockingMessage: string;
      refreshLabel: string;
    };
    applications: {
      eyebrow: string;
      title: string;
      note: string;
      checkLabel: string;
      checkingLabel: string;
      readyLabel: string;
      unavailableLabel: string;
      notCheckedLabel: string;
      installedLabel: string;
      versionLabel: string;
      lastCheckedLabel: string;
      commandLabel: string;
      yesLabel: string;
      noLabel: string;
      unknownLabel: string;
      neverLabel: string;
    };
  }
> = {
  en: {
    modalEyebrow: "Settings",
    modalTitle: "Settings",
    closeLabel: "Close",
    sectionsAriaLabel: "Settings Sections",
    sections: {
      general: "General",
      updates: "Software Update",
      recorder: "Learning Mode",
      permissions: "Permissions",
      applications: "Applications",
      llm: "Model",
    },
    general: {
      eyebrow: "General",
      title: "Choose the app display language",
      note: "Switch the main interface and settings between English and Chinese.",
      windowsChineseInputNote:
        "Chinese input is not supported in the Windows version yet.",
      languageLabel: "Display Language",
      languageAriaLabel: "Display Language",
      saveLabel: "Save General Settings",
    },
    recorder: {
      eyebrow: "Learning Mode",
      title: "Choose how OysterWorkflow learns your workflow context",
      note: "Set OCR language priority and decide whether Learning Mode can include system audio.",
      priorityLabel: (index) => `Priority ${index + 1}`,
      priorityAriaLabel: (index) => `OCR Priority ${index + 1}`,
      notSetLabel: "Not set",
      audioLabel: "Audio",
      audioToggleLabel: "Enable audio",
      audioTitle: "Enable audio",
      audioDescription:
        "When enabled, you can explain your current steps out loud to help AI understand the on-screen workflow.",
      resetLabel: "Reset Defaults",
      saveLabel: "Save Learning Settings",
    },
    permissions: {
      eyebrow: "Permissions",
      title: "Allow Learning Mode access before training",
      checkingSummary: "Checking Learning Mode permissions now...",
      fallbackSummary:
        "Open each System Settings page below, grant access, then return here and refresh.",
      blockingMessage:
        "Learning Mode is blocked until the required permissions are granted.",
      refreshLabel: "Refresh Status",
    },
    applications: {
      eyebrow: "Applications",
      title: "Connections and application access",
      note: "Manage local browser access and cloud application connections used by AI workers. Chrome may restart once after first-time debug approval.",
      checkLabel: "Check Chrome",
      checkingLabel: "Checking...",
      readyLabel: "Ready",
      unavailableLabel: "Needs attention",
      notCheckedLabel: "Not checked",
      installedLabel: "Installed",
      versionLabel: "Version",
      lastCheckedLabel: "Last checked",
      commandLabel: "Helper",
      yesLabel: "Yes",
      noLabel: "No",
      unknownLabel: "Unknown",
      neverLabel: "Never",
    },
  },
  zh: {
    modalEyebrow: "设置",
    modalTitle: "设置",
    closeLabel: "关闭",
    sectionsAriaLabel: "设置分区",
    sections: {
      general: "通用",
      updates: "软件更新",
      recorder: "学习模式",
      permissions: "权限",
      applications: "应用",
      llm: "模型",
    },
    general: {
      eyebrow: "通用",
      title: "选择应用显示语言",
      note: "在英文和中文之间切换主界面与设置页展示。",
      windowsChineseInputNote: "Windows 版本暂时不支持中文输入。",
      languageLabel: "显示语言",
      languageAriaLabel: "显示语言",
      saveLabel: "保存通用设置",
    },
    recorder: {
      eyebrow: "学习模式",
      title: "选择 OysterWorkflow 学习工作流上下文的方式",
      note: "设置 OCR 语言优先级，并决定学习模式是否包含系统音频。",
      priorityLabel: (index) => `优先级 ${index + 1}`,
      priorityAriaLabel: (index) => `OCR 优先级 ${index + 1}`,
      notSetLabel: "未设置",
      audioLabel: "音频",
      audioToggleLabel: "启用音频",
      audioTitle: "启用音频",
      audioDescription:
        "启用后，你可以口述当前步骤，帮助 AI 理解屏幕上的工作流。",
      resetLabel: "恢复默认",
      saveLabel: "保存学习设置",
    },
    permissions: {
      eyebrow: "权限",
      title: "训练前授予学习模式访问权限",
      checkingSummary: "正在检查学习模式权限...",
      fallbackSummary:
        "打开下面的系统权限页面并授予访问权限，然后返回这里刷新。",
      blockingMessage: "学习模式会保持阻塞，直到必需权限已授予。",
      refreshLabel: "刷新状态",
    },
    applications: {
      eyebrow: "应用",
      title: "连接与应用访问",
      note: "统一管理 AI Worker 使用的本地浏览器能力与云端应用连接。首次批准调试后，Chrome 可能会完整重启一次。",
      checkLabel: "检测 Chrome",
      checkingLabel: "检测中...",
      readyLabel: "可用",
      unavailableLabel: "需要处理",
      notCheckedLabel: "未检测",
      installedLabel: "已安装",
      versionLabel: "版本",
      lastCheckedLabel: "上次检测",
      commandLabel: "辅助程序",
      yesLabel: "是",
      noLabel: "否",
      unknownLabel: "未知",
      neverLabel: "从未",
    },
  },
};

const UPDATE_COPY: Record<
  AppLanguage,
  {
    eyebrow: string;
    title: string;
    note: string;
    currentVersionLabel: string;
    availableVersionLabel: string;
    lastCheckedLabel: string;
    neverLabel: string;
    unknownLabel: string;
    releaseNotesLabel: string;
    progressLabel: string;
    checkLabel: string;
    checkingLabel: string;
    downloadLabel: string;
    retryDownloadLabel: string;
    downloadingLabel: string;
    installLabel: string;
    installingLabel: string;
    preserveDataNote: string;
    status: Record<DesktopUpdatePhase, string>;
    description: Record<DesktopUpdatePhase, string>;
    error: Record<DesktopUpdateErrorCode, string>;
  }
> = {
  en: {
    eyebrow: "Software Update",
    title: "Keep OysterWorkflow up to date",
    note: "OysterWorkflow checks the signed public release channel when the desktop app starts.",
    currentVersionLabel: "Current version",
    availableVersionLabel: "Available version",
    lastCheckedLabel: "Last checked",
    neverLabel: "Not checked yet",
    unknownLabel: "Unknown",
    releaseNotesLabel: "What is new",
    progressLabel: "Update download progress",
    checkLabel: "Check for Updates",
    checkingLabel: "Checking...",
    downloadLabel: "Download Update",
    retryDownloadLabel: "Retry Download",
    downloadingLabel: "Downloading...",
    installLabel: "Restart and Install",
    installingLabel: "Preparing Install...",
    preserveDataNote:
      "Installing an update keeps your local workflows, settings, and recordings in place.",
    status: {
      unsupported: "Unavailable",
      idle: "Ready to check",
      checking: "Checking",
      available: "Update available",
      downloading: "Downloading",
      downloaded: "Ready to install",
      up_to_date: "Up to date",
      installing: "Installing",
      error: "Needs attention",
    },
    description: {
      unsupported:
        "Update checks are available in an installed macOS or Windows build.",
      idle: "Check the release channel for a newer signed version.",
      checking: "Contacting the release channel now.",
      available: "A newer signed version is ready to download.",
      downloading: "You can keep using OysterWorkflow while it downloads.",
      downloaded: "The update has downloaded and can be installed now.",
      up_to_date: "This device is running the newest available version.",
      installing: "OysterWorkflow will close, install the update, and reopen.",
      error: "The update operation did not complete. Try again.",
    },
    error: {
      release_metadata_unavailable:
        "The Windows release is temporarily missing update information. Try again later.",
      network_unavailable:
        "OysterWorkflow could not reach the update service. Check your connection and try again.",
      operation_failed:
        "OysterWorkflow could not complete the update operation. Try again.",
    },
  },
  zh: {
    eyebrow: "软件更新",
    title: "保持 OysterWorkflow 为最新版本",
    note: "桌面应用启动时，OysterWorkflow 会检查已签名的公开发布通道。",
    currentVersionLabel: "当前版本",
    availableVersionLabel: "可用版本",
    lastCheckedLabel: "上次检查",
    neverLabel: "尚未检查",
    unknownLabel: "未知",
    releaseNotesLabel: "更新内容",
    progressLabel: "更新下载进度",
    checkLabel: "检查更新",
    checkingLabel: "正在检查...",
    downloadLabel: "下载更新",
    retryDownloadLabel: "重新下载",
    downloadingLabel: "正在下载...",
    installLabel: "重启并安装",
    installingLabel: "正在准备安装...",
    preserveDataNote: "安装更新不会删除本地工作流、设置或录制内容。",
    status: {
      unsupported: "不可用",
      idle: "可以检查",
      checking: "正在检查",
      available: "有可用更新",
      downloading: "正在下载",
      downloaded: "可以安装",
      up_to_date: "已是最新版本",
      installing: "正在安装",
      error: "需要处理",
    },
    description: {
      unsupported: "更新检查仅适用于已安装的 macOS 或 Windows 版本。",
      idle: "检查发布通道中是否有更新的已签名版本。",
      checking: "正在连接发布通道。",
      available: "已有更新的已签名版本可以下载。",
      downloading: "下载期间可以继续使用 OysterWorkflow。",
      downloaded: "更新已下载，现在可以安装。",
      up_to_date: "这台设备正在运行当前最新版本。",
      installing: "OysterWorkflow 将退出、安装更新，然后重新打开。",
      error: "更新操作未完成，请重试。",
    },
    error: {
      release_metadata_unavailable:
        "当前 Windows 版本的更新信息暂未发布，请稍后重试。",
      network_unavailable: "无法连接更新服务，请检查网络后重试。",
      operation_failed: "无法完成更新操作，请稍后重试。",
    },
  },
};

interface GeneralSettingsSectionProps {
  draft: AppLanguage;
  feedback: string | null;
  onChange: (value: AppLanguage) => void;
  onSave: () => void;
}

interface RecorderSettingsSectionProps {
  draft: RecorderLanguageSlotValue[];
  enableAudio: boolean;
  errorMessage: string | null;
  feedback: string | null;
  onChange: (index: number, value: RecorderLanguageSlotValue) => void;
  onEnableAudioChange: (value: boolean) => void;
  onReset: () => void;
  onSave: () => void;
}

interface PermissionsSettingsSectionProps {
  mode: PermissionsModalMode | null;
  permissions: RecorderPermissionsResponse | null;
  loading: boolean;
  errorMessage: string | null;
  requestingKind: RecorderPermissionKind | null;
  onRefresh: () => void;
  onRequestPermission: (kind: RecorderPermissionKind) => void;
}

interface ApplicationsSettingsSectionProps {
  providers: ProductCapabilityProvider[];
  checkingProviderId: ProductCapabilityProviderId | null;
  errorMessage: string | null;
  onCheckProvider: (providerId: ProductCapabilityProviderId) => void;
}

interface UpdatesSettingsSectionProps {
  snapshot: DesktopUpdateSnapshot;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
}

interface LlmSettingsSectionProps {
  form: LlmFormState | null;
  startupSetup: boolean;
  startupConnectionReady?: boolean;
  runtimePreparation: StartupRuntimePreparationStatus;
  loading: boolean;
  errorMessage: string | null;
  feedback: string | null;
  busy: boolean;
  availableModels: string[];
  modelsLoading: boolean;
  modelsLoaded: boolean;
  modelsError: string | null;
  checkingConnection: boolean;
  connectionError: string | null;
  onRetry: () => void;
  onRetryRuntimePreparation: () => void;
  onLoadModels: () => void | Promise<void>;
  onCheckConnection: () => void | Promise<void>;
  onUpdateField: <K extends keyof LlmFormState>(
    key: K,
    value: LlmFormState[K],
  ) => void;
  onUpdateCallProfileField: <K extends keyof LlmCallProfileFormState>(
    key: LabLlmCallProfileKey,
    field: K,
    value: LlmCallProfileFormState[K],
  ) => void;
  onSave: () => void;
}

export interface StartupLlmSetupModalProps {
  open: boolean;
  language: AppLanguage;
  llm: Omit<LlmSettingsSectionProps, "startupSetup">;
  onContinue: () => void;
}

type LlmAdvancedDialog = "timeout" | "reasoning" | null;

export interface SettingsModalProps {
  open: boolean;
  language: AppLanguage;
  activeSection: SettingsSection;
  isDesktopRuntime: boolean;
  runtimePlatform: string;
  busy: boolean;
  onSectionChange: (section: SettingsSection) => void;
  onClose: () => void;
  general: GeneralSettingsSectionProps;
  recorder: RecorderSettingsSectionProps;
  permissions: PermissionsSettingsSectionProps;
  applications: ApplicationsSettingsSectionProps;
  updates: UpdatesSettingsSectionProps;
  llm: LlmSettingsSectionProps;
}

export interface StartupPermissionGateProps {
  open: boolean;
  language: AppLanguage;
  permissions: RecorderPermissionsResponse | null;
  loading: boolean;
  errorMessage: string | null;
  requestingKind: RecorderPermissionKind | null;
  allGranted: boolean;
  canQuitAndReopen: boolean;
  onContinue: () => void;
  onRefresh: () => void;
  onQuitAndReopen: () => void;
  onRequestPermission: (kind: RecorderPermissionKind) => void;
}

/**
 * EN: Renders the unified settings modal so recorder, permissions, and LLM config live under one entry point.
 * @param input section state plus callbacks from the main app shell.
 * @returns modal content or null when closed.
 */
export function SettingsModal(input: SettingsModalProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  useTopmostModal({
    open: input.open,
    containerRef: frameRef,
    onClose: input.onClose,
  });

  if (!input.open) {
    return null;
  }

  const copy = SETTINGS_COPY[input.language];
  const sections = input.isDesktopRuntime
    ? [
        { key: "general" as const, label: copy.sections.general },
        { key: "updates" as const, label: copy.sections.updates },
        { key: "recorder" as const, label: copy.sections.recorder },
        { key: "permissions" as const, label: copy.sections.permissions },
        { key: "applications" as const, label: copy.sections.applications },
        { key: "llm" as const, label: copy.sections.llm },
      ]
    : [
        { key: "general" as const, label: copy.sections.general },
        { key: "recorder" as const, label: copy.sections.recorder },
        { key: "applications" as const, label: copy.sections.applications },
        { key: "llm" as const, label: copy.sections.llm },
      ];
  const activeSection = sections.some(
    (section) => section.key === input.activeSection,
  )
    ? input.activeSection
    : sections[0].key;

  return (
    <div className="modal-backdrop settings-modal-backdrop">
      <div className="settings-modal-frame" ref={frameRef}>
        <button
          type="button"
          className="settings-floating-close"
          onClick={input.onClose}
          aria-label={copy.closeLabel}
          title={copy.closeLabel}
        >
          <span aria-hidden="true">×</span>
        </button>
        <section
          className="settings-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-modal-title"
        >
          <div className="permissions-modal-topline">
            <div>
              <h2 id="settings-modal-title">{copy.modalTitle}</h2>
            </div>
          </div>

          <div className="settings-layout">
            <nav className="settings-nav" aria-label={copy.sectionsAriaLabel}>
              {sections.map((section) => (
                <button
                  key={section.key}
                  className={
                    activeSection === section.key
                      ? "settings-nav-button active"
                      : "settings-nav-button"
                  }
                  onClick={() => input.onSectionChange(section.key)}
                >
                  {section.label}
                </button>
              ))}
            </nav>

            <div className="settings-panel">
              {activeSection === "general" ? (
                <GeneralSettingsSection
                  {...input.general}
                  language={input.language}
                  runtimePlatform={input.runtimePlatform}
                />
              ) : null}
              {activeSection === "recorder" ? (
                <RecorderSettingsSection
                  {...input.recorder}
                  language={input.language}
                />
              ) : null}
              {activeSection === "updates" ? (
                <UpdatesSettingsSection
                  {...input.updates}
                  language={input.language}
                />
              ) : null}
              {activeSection === "permissions" ? (
                <PermissionsSettingsSection
                  {...input.permissions}
                  language={input.language}
                />
              ) : null}
              {activeSection === "applications" ? (
                <ApplicationsSettingsSection
                  {...input.applications}
                  language={input.language}
                />
              ) : null}
              {activeSection === "llm" ? (
                <LlmSettingsSection {...input.llm} language={input.language} />
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * EN: Renders first-run model setup as its own onboarding surface after permissions.
 * 中文: 在权限步骤之后，以独立引导弹窗呈现首次模型配置。
 * @param input modal visibility, localized form state, and actions.
 * @returns standalone first-run model setup dialog or null.
 */
export function StartupLlmSetupModal(input: StartupLlmSetupModalProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const scrollRegionRef = useRef<HTMLDivElement>(null);
  useTopmostModal({
    open: input.open,
    containerRef: frameRef,
    closeOnEscape: false,
    initialFocusRef: scrollRegionRef,
  });

  if (!input.open) {
    return null;
  }

  const readyDependencyCount = input.llm.runtimePreparation.dependencies.filter(
    (dependency) => dependency.phase === "ready",
  ).length;
  const allDependenciesReady =
    input.llm.runtimePreparation.dependencies.length === 3 &&
    readyDependencyCount === 3;
  const setupReady =
    allDependenciesReady && input.llm.startupConnectionReady === true;
  const completedCount =
    readyDependencyCount + (input.llm.startupConnectionReady ? 1 : 0);
  const t = (english: string, chinese: string) =>
    input.language === "zh" ? chinese : english;
  return (
    <div className="modal-backdrop startup-llm-backdrop">
      <div className="startup-llm-modal-frame" ref={frameRef}>
        <section
          className="settings-modal startup-llm-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="startup-llm-title"
        >
          <div
            ref={scrollRegionRef}
            className="startup-llm-scroll-region"
            tabIndex={0}
            aria-label={t("LLM setup form", "LLM 配置表单")}
            onKeyDown={handleScrollableRegionKeyDown}
          >
            <LlmSettingsSection
              {...input.llm}
              startupSetup
              language={input.language}
            />
          </div>
          <footer
            className={`startup-llm-completion${setupReady ? " is-ready" : ""}`}
          >
            <div>
              <strong>
                {setupReady
                  ? t("Setup complete", "配置已完成")
                  : t("Finish setup to continue", "完成配置后继续")}
              </strong>
              <p>
                {setupReady
                  ? t(
                      "Your LLM and all three local tools are ready.",
                      "LLM 与三个本地工具均已就绪。",
                    )
                  : t(
                      `${completedCount} of 4 checks are ready.`,
                      `4 项检查中已有 ${completedCount} 项就绪。`,
                    )}
              </p>
            </div>
            <button
              type="button"
              className="action-button action-primary"
              disabled={!setupReady}
              onClick={input.onContinue}
            >
              {t("Start using OysterWorkflow", "开始使用 OysterWorkflow")}
            </button>
          </footer>
        </section>
      </div>
    </div>
  );
}

export function StartupPermissionGate(input: StartupPermissionGateProps) {
  const dialogRef = useRef<HTMLElement>(null);
  useTopmostModal({
    open: input.open,
    containerRef: dialogRef,
    closeOnEscape: false,
  });
  if (!input.open) {
    return null;
  }

  const items = input.permissions?.items ?? buildFallbackPermissionItems();
  const t = (english: string, chinese: string) =>
    input.language === "zh" ? chinese : english;
  const summaryMessage = input.allGranted
    ? t(
        "All required Learning Mode permissions are granted. Continue to setup.",
        "Learning Mode 所需权限已全部授予，可以继续设置。",
      )
    : t(
        "Grant each permission, then quit and reopen OysterWorkflow to verify it.",
        "请依次授予权限，然后退出并重新打开 OysterWorkflow 进行验证。",
      );

  return (
    <div className="modal-backdrop startup-permission-backdrop">
      <section
        ref={dialogRef}
        className="settings-modal startup-permission-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="startup-permission-title"
      >
        <div className="settings-section startup-permission-section">
          <div className="settings-section-topline">
            <div>
              <p className="eyebrow">{t("Permissions", "系统权限")}</p>
              <h2 id="startup-permission-title">
                {t(
                  "Allow Learning Mode before continuing",
                  "继续前，请先允许 Learning Mode 所需权限",
                )}
              </h2>
            </div>
          </div>

          <p className="startup-permission-status">{summaryMessage}</p>
          {!input.allGranted ? (
            <p className="inline-note">
              {t(
                "Request each permission below. macOS will guide you if System Settings is required.",
                "请依次请求下列权限；如需前往系统设置，macOS 会自动引导你。",
              )}
            </p>
          ) : null}
          {input.errorMessage ? (
            <p className="inline-error">{input.errorMessage}</p>
          ) : null}

          <div className="permission-list startup-permission-list">
            {items.map((item) => (
              <article className="permission-card" key={item.kind}>
                <div className="permission-card-header">
                  <div>
                    <h3>{startupPermissionLabel(item.kind, input.language)}</h3>
                    <p>
                      {startupPermissionDescription(item.kind, input.language)}
                    </p>
                  </div>
                  <span className={`permission-badge permission-${item.state}`}>
                    {formatStartupPermissionState(item.state, input.language)}
                  </span>
                </div>
                {item.detail.trim().length > 0 ? (
                  <p className="permission-detail">{item.detail}</p>
                ) : null}
                <div className="permission-card-actions">
                  <button
                    className="action-button action-secondary"
                    disabled={
                      input.loading ||
                      input.requestingKind !== null ||
                      item.state === "granted"
                    }
                    onClick={() => input.onRequestPermission(item.kind)}
                  >
                    {input.requestingKind === item.kind
                      ? t("Requesting...", "正在请求...")
                      : t("Request permission", "请求权限")}
                  </button>
                </div>
              </article>
            ))}
          </div>

          <div className="settings-actions startup-permission-actions">
            {input.allGranted ? (
              <button
                className="action-button action-primary"
                disabled={input.loading || input.requestingKind !== null}
                onClick={input.onContinue}
              >
                {t("Continue", "继续")}
              </button>
            ) : (
              <>
                <button
                  className="action-button"
                  disabled={input.loading || input.requestingKind !== null}
                  onClick={input.onRefresh}
                >
                  {t("Refresh status", "刷新权限状态")}
                </button>
                <button
                  className="action-button action-primary"
                  disabled={
                    input.loading ||
                    input.requestingKind !== null ||
                    !input.canQuitAndReopen
                  }
                  onClick={input.onQuitAndReopen}
                >
                  {t("Quit & Reopen to Verify", "退出并重新打开以验证")}
                </button>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function GeneralSettingsSection(
  input: GeneralSettingsSectionProps & {
    language: AppLanguage;
    runtimePlatform: string;
  },
) {
  const copy = SETTINGS_COPY[input.language].general;
  const note =
    input.runtimePlatform === "win32"
      ? `${copy.note} ${copy.windowsChineseInputNote}`
      : copy.note;

  return (
    <section className="settings-section">
      <div className="settings-section-topline">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h3>{copy.title}</h3>
        </div>
      </div>

      <p className="inline-note">{note}</p>
      <div className="recorder-config-fields">
        <label className="form-field form-field-wide">
          <span>{copy.languageLabel}</span>
          <select
            aria-label={copy.languageAriaLabel}
            value={input.draft}
            onChange={(event) =>
              input.onChange(event.target.value as AppLanguage)
            }
          >
            {APP_LANGUAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {formatAppLanguageLabel(option.value)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {input.feedback ? (
        <p className="inline-note" role="status">
          {input.feedback}
        </p>
      ) : null}

      <div className="settings-actions">
        <button className="action-button action-primary" onClick={input.onSave}>
          {copy.saveLabel}
        </button>
      </div>
    </section>
  );
}

/**
 * EN: Presents the complete manual update flow without owning download or install behavior.
 * 中文: 展示完整的手动更新流程，但不承担下载或安装行为。
 * @param input immutable update snapshot, localized language, and user actions.
 * @returns settings section for checking, downloading, and installing updates.
 */
function UpdatesSettingsSection(
  input: UpdatesSettingsSectionProps & { language: AppLanguage },
) {
  const copy = UPDATE_COPY[input.language];
  const { snapshot } = input;
  const busy =
    snapshot.phase === "checking" ||
    snapshot.phase === "downloading" ||
    snapshot.phase === "installing";
  const canRetryDownload =
    snapshot.phase === "error" && Boolean(snapshot.availableVersion);
  const action =
    snapshot.phase === "downloaded"
      ? { label: copy.installLabel, onClick: input.onInstall }
      : snapshot.phase === "available" || canRetryDownload
        ? {
            label: canRetryDownload
              ? copy.retryDownloadLabel
              : copy.downloadLabel,
            onClick: input.onDownload,
          }
        : {
            label:
              snapshot.phase === "checking"
                ? copy.checkingLabel
                : snapshot.phase === "downloading"
                  ? copy.downloadingLabel
                  : snapshot.phase === "installing"
                    ? copy.installingLabel
                    : copy.checkLabel,
            onClick: input.onCheck,
          };

  return (
    <section className="settings-section update-settings-section">
      <div className="settings-section-topline">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h3>{copy.title}</h3>
        </div>
        <span className={`update-status-badge is-${snapshot.phase}`}>
          {copy.status[snapshot.phase]}
        </span>
      </div>

      <p className="inline-note">{copy.note}</p>
      <div className="update-status-panel" aria-live="polite">
        <strong>{copy.status[snapshot.phase]}</strong>
        <p>{copy.description[snapshot.phase]}</p>
      </div>

      <dl className="update-version-meta">
        <div>
          <dt>{copy.currentVersionLabel}</dt>
          <dd>
            {snapshot.currentVersion
              ? `v${snapshot.currentVersion}`
              : copy.unknownLabel}
          </dd>
        </div>
        {snapshot.availableVersion ? (
          <div>
            <dt>{copy.availableVersionLabel}</dt>
            <dd>{`v${snapshot.availableVersion}`}</dd>
          </div>
        ) : null}
        <div>
          <dt>{copy.lastCheckedLabel}</dt>
          <dd>{formatUpdateCheckedAt(snapshot.checkedAt, copy.neverLabel)}</dd>
        </div>
      </dl>

      {snapshot.phase === "downloading" && snapshot.progress ? (
        <div className="update-download-progress">
          <progress
            aria-label={copy.progressLabel}
            max="100"
            value={snapshot.progress.percent}
          />
          <div>
            <strong>{`${Math.round(snapshot.progress.percent)}%`}</strong>
            <span>
              {formatUpdateProgress(snapshot.progress, input.language)}
            </span>
          </div>
        </div>
      ) : null}

      {snapshot.releaseNotes ? (
        <div className="update-release-notes">
          <h4>{copy.releaseNotesLabel}</h4>
          <p>{snapshot.releaseNotes}</p>
        </div>
      ) : null}

      {snapshot.phase === "error" ? (
        <p className="inline-error" role="alert">
          {copy.error[snapshot.errorCode ?? "operation_failed"]}
        </p>
      ) : null}

      <p className="update-preserve-note">{copy.preserveDataNote}</p>
      <div className="settings-actions">
        <button
          className="action-button action-primary"
          disabled={!snapshot.supported || busy}
          aria-busy={busy}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      </div>
    </section>
  );
}

function formatUpdateCheckedAt(
  value: string | null,
  neverLabel: string,
): string {
  if (!value) {
    return neverLabel;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatUpdateProgress(
  progress: NonNullable<DesktopUpdateSnapshot["progress"]>,
  language: AppLanguage,
): string {
  const transferred = formatUpdateBytes(progress.transferredBytes);
  const total = formatUpdateBytes(progress.totalBytes);
  const speed = formatUpdateBytes(progress.bytesPerSecond);
  return language === "zh"
    ? `${transferred} / ${total}，每秒 ${speed}`
    : `${transferred} / ${total}, ${speed} per second`;
}

function formatUpdateBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 MB";
  }
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(
    units.length - 1,
    Math.floor(Math.log(value) / Math.log(1024)),
  );
  const scaled = value / 1024 ** unitIndex;
  return `${scaled >= 10 || unitIndex === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[unitIndex]}`;
}

function RecorderSettingsSection(
  input: RecorderSettingsSectionProps & { language: AppLanguage },
) {
  const copy = SETTINGS_COPY[input.language].recorder;

  return (
    <section className="settings-section">
      <div className="settings-section-topline">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h3>{copy.title}</h3>
        </div>
      </div>

      <p className="inline-note">{copy.note}</p>
      <div className="recorder-config-fields">
        {Array.from({
          length: RECORDER_LANGUAGE_PRIORITY_SLOT_COUNT,
        }).map((_, index) => (
          <label className="form-field" key={`recorder-language-${index}`}>
            <span>{copy.priorityLabel(index)}</span>
            <select
              aria-label={copy.priorityAriaLabel(index)}
              value={input.draft[index] ?? ""}
              onChange={(event) =>
                input.onChange(
                  index,
                  event.target.value as RecorderLanguageSlotValue,
                )
              }
            >
              <option value="">{copy.notSetLabel}</option>
              {LAB_SCREENPIPE_LANGUAGES.map((language) => (
                <option key={language} value={language}>
                  {formatRecorderLanguageLabel(language, input.language)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="form-field form-field-wide recorder-audio-field">
        <span>{copy.audioLabel}</span>
        <label className="recorder-audio-toggle">
          <input
            aria-label={copy.audioToggleLabel}
            type="checkbox"
            checked={input.enableAudio}
            onChange={(event) =>
              input.onEnableAudioChange(event.target.checked)
            }
          />
          <div className="recorder-audio-copy">
            <strong>{copy.audioTitle}</strong>
            <small>{copy.audioDescription}</small>
          </div>
        </label>
      </div>
      {input.errorMessage ? (
        <p className="inline-error">{input.errorMessage}</p>
      ) : null}
      {input.feedback ? (
        <p className="inline-note" role="status">
          {input.feedback}
        </p>
      ) : null}

      <div className="settings-actions">
        <button className="action-button" onClick={input.onReset}>
          {copy.resetLabel}
        </button>
        <button className="action-button action-primary" onClick={input.onSave}>
          {copy.saveLabel}
        </button>
      </div>
    </section>
  );
}

function PermissionsSettingsSection(
  input: PermissionsSettingsSectionProps & { language: AppLanguage },
) {
  const copy = SETTINGS_COPY[input.language].permissions;
  const items = input.permissions?.items ?? buildFallbackPermissionItems();
  const summaryMessage = input.loading
    ? copy.checkingSummary
    : input.permissions?.allGranted
      ? null
      : (input.permissions?.summary ?? copy.fallbackSummary);

  return (
    <section className="settings-section">
      <div className="settings-section-topline">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h3>{copy.title}</h3>
        </div>
      </div>

      {input.mode === "blocking" ? (
        <p className="inline-error">{copy.blockingMessage}</p>
      ) : null}
      {summaryMessage ? <p className="inline-note">{summaryMessage}</p> : null}
      {input.errorMessage ? (
        <p className="inline-error">{input.errorMessage}</p>
      ) : null}

      <div className="permission-list">
        {items.map((item) => (
          <article className="permission-card" key={item.kind}>
            <div className="permission-card-header">
              <div>
                <h3>{item.label}</h3>
                <p>{item.description}</p>
              </div>
              <span className={`permission-badge permission-${item.state}`}>
                {formatPermissionState(item.state)}
              </span>
            </div>
            {item.state !== "granted" && item.detail.trim().length > 0 ? (
              <p className="permission-detail">{item.detail}</p>
            ) : null}
            {item.state !== "granted" ? (
              <button
                className="action-button action-secondary"
                disabled={input.loading || input.requestingKind !== null}
                onClick={() => input.onRequestPermission(item.kind)}
              >
                {getPermissionActionLabel(item, input.requestingKind)}
              </button>
            ) : null}
          </article>
        ))}
      </div>

      <div className="settings-actions">
        <button
          className="action-button action-primary"
          disabled={input.loading || input.requestingKind !== null}
          onClick={input.onRefresh}
        >
          {copy.refreshLabel}
        </button>
      </div>
    </section>
  );
}

function ApplicationsSettingsSection(
  input: ApplicationsSettingsSectionProps & { language: AppLanguage },
) {
  const copy = SETTINGS_COPY[input.language].applications;
  const providers = input.providers.filter(
    (provider) => provider.id !== "composio",
  );

  return (
    <section className="settings-section">
      <div className="settings-section-topline">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h3>{copy.title}</h3>
        </div>
      </div>

      <p className="inline-note">{copy.note}</p>
      {input.errorMessage ? (
        <p className="inline-error">{input.errorMessage}</p>
      ) : null}

      <ComposioConnections language={input.language} />

      <p className="application-local-heading">
        {input.language === "zh" ? "本地应用能力" : "Local application access"}
      </p>
      <div className="application-capability-list">
        {providers.map((provider) => {
          const isChecking =
            input.checkingProviderId === provider.id ||
            provider.status === "checking";
          const displayDetail =
            provider.id === "chrome"
              ? formatChromeCapabilityDetail(
                  provider,
                  input.language,
                  input.errorMessage,
                )
              : provider.detail;
          return (
            <article className="application-capability-card" key={provider.id}>
              <div className="application-capability-header">
                <div>
                  <h3>{provider.label}</h3>
                  <p>{provider.description}</p>
                </div>
                <span
                  className={`permission-badge permission-${providerStatusTone(
                    provider,
                  )}`}
                >
                  {formatProviderStatus(provider, copy)}
                </span>
              </div>

              {displayDetail ? (
                <p className="application-capability-detail">{displayDetail}</p>
              ) : null}
              {provider.lastError ? (
                <details className="application-capability-diagnostics">
                  <summary>
                    {input.language === "zh" ? "技术详情" : "Technical details"}
                  </summary>
                  <pre>{provider.lastError}</pre>
                </details>
              ) : null}

              <dl className="application-capability-meta">
                <div>
                  <dt>{copy.installedLabel}</dt>
                  <dd>{provider.installed ? copy.yesLabel : copy.noLabel}</dd>
                </div>
                <div>
                  <dt>{copy.versionLabel}</dt>
                  <dd>
                    {provider.version ??
                      provider.pinnedVersion ??
                      copy.unknownLabel}
                  </dd>
                </div>
                <div>
                  <dt>{copy.lastCheckedLabel}</dt>
                  <dd>
                    {formatProviderCheckedAt(
                      provider.lastCheckedAt,
                      copy.neverLabel,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{copy.commandLabel}</dt>
                  <dd>{provider.commandPath ?? copy.unknownLabel}</dd>
                </div>
              </dl>

              <div className="settings-actions application-capability-actions">
                <button
                  className="action-button action-primary"
                  disabled={isChecking}
                  onClick={() => input.onCheckProvider(provider.id)}
                >
                  {isChecking ? copy.checkingLabel : copy.checkLabel}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function providerStatusTone(provider: ProductCapabilityProvider): string {
  if (provider.status === "ready") {
    return "granted";
  }
  if (provider.status === "unavailable") {
    return "missing";
  }
  if (provider.status === "checking") {
    return "preparing";
  }
  return "unknown";
}

function formatProviderStatus(
  provider: ProductCapabilityProvider,
  copy: (typeof SETTINGS_COPY)[AppLanguage]["applications"],
): string {
  if (provider.status === "ready") {
    return copy.readyLabel;
  }
  if (provider.status === "unavailable") {
    return copy.unavailableLabel;
  }
  if (provider.status === "checking") {
    return copy.checkingLabel;
  }
  return copy.notCheckedLabel;
}

function formatProviderCheckedAt(
  value: string | null,
  neverLabel: string,
): string {
  if (!value) {
    return neverLabel;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

interface AdvancedConfigDialogProps {
  open: boolean;
  dialogTitle: string;
  dialogDescription: string;
  titleId: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * EN: Renders a focused dialog for advanced LLM settings so the user does not miss newly available controls.
 * @param input dialog metadata, visibility, and body content.
 * @returns modal content when open, otherwise null.
 */
function AdvancedConfigDialog(input: AdvancedConfigDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  useTopmostModal({
    open: input.open,
    containerRef: dialogRef,
    onClose: input.onClose,
  });
  if (!input.open) {
    return null;
  }

  return (
    <div
      className="modal-backdrop settings-dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          input.onClose();
        }
      }}
    >
      <section
        ref={dialogRef}
        className="settings-modal settings-dialog-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={input.titleId}
      >
        <div className="settings-section settings-dialog-section">
          <div className="settings-section-topline">
            <div>
              <p className="eyebrow">Advanced</p>
              <h2 id={input.titleId}>{input.dialogTitle}</h2>
            </div>
            <button className="action-button" onClick={input.onClose}>
              Close
            </button>
          </div>
          <p className="inline-note settings-dialog-copy">
            {input.dialogDescription}
          </p>
          {input.children}
        </div>
      </section>
    </div>
  );
}

function LlmSettingsSection(
  input: LlmSettingsSectionProps & { language: AppLanguage },
) {
  const form = input.form;
  const t = (english: string, chinese: string) =>
    input.language === "zh" ? chinese : english;
  const [advancedDialog, setAdvancedDialog] = useState<LlmAdvancedDialog>(null);
  const timeoutConfigOption = form
    ? resolveLlmTimeoutConfigOption(form)
    : "streaming-output";
  const globalReasoningOption: LlmGlobalReasoningOption = form
    ? form.advancedReasoningConfigEnabled
      ? LLM_CUSTOMIZED_REASONING_OPTION.value
      : (form.reasoningEffort as LlmGlobalReasoningOption)
    : "high";
  const resolvedModel = form ? resolveLlmModelValue(form) : "";
  const modelOptions = input.modelsLoaded
    ? input.availableModels.map((model) => ({ value: model, label: model }))
    : LLM_MODEL_PRESET_OPTIONS.filter((option) => option.value !== "custom");
  const selectedModelIsAvailable = modelOptions.some(
    (option) => option.value === resolvedModel,
  );
  const modelSelectValue = selectedModelIsAvailable
    ? `model:${resolvedModel}`
    : "custom";
  const showCustomModel = modelSelectValue === "custom";
  const customModelValue =
    form?.modelPreset === "custom" ? form.customModel : resolvedModel;
  const allRuntimeDependenciesReady =
    input.runtimePreparation.dependencies.length === 3 &&
    input.runtimePreparation.dependencies.every(
      (dependency) => dependency.phase === "ready",
    );
  const runtimeNeedsAttention = input.runtimePreparation.dependencies.some(
    (dependency) => dependency.phase === "attention",
  );

  useEffect(() => {
    if (!form) {
      setAdvancedDialog(null);
      return;
    }

    if (advancedDialog === "timeout" && !form.advancedTimeoutConfigEnabled) {
      setAdvancedDialog(null);
      return;
    }

    if (
      advancedDialog === "reasoning" &&
      !form.advancedReasoningConfigEnabled
    ) {
      setAdvancedDialog(null);
    }
  }, [advancedDialog, form]);

  return (
    <section className="settings-section llm-settings-section">
      <div className="settings-section-topline">
        <div>
          <p className="eyebrow">
            {input.startupSetup
              ? t("Workspace setup", "工作空间设置")
              : t("Model", "模型")}
          </p>
          <h3 id={input.startupSetup ? "startup-llm-title" : undefined}>
            {input.startupSetup
              ? t("Prepare OysterWorkflow", "准备 OysterWorkflow")
              : t("Model connection", "模型连接")}
          </h3>
          <p className="settings-section-description">
            {input.startupSetup
              ? t(
                  "Complete the required model and local-tool checks before entering the workspace.",
                  "进入工作空间前，请完成模型与本地工具的必需检查。",
                )
              : t(
                  "Configure the model used by workflows and AI workers. Test connection checks the current fields without saving them.",
                  "配置工作流和 AI Worker 使用的模型。“检测连接”只检查当前表单，不会保存更改。",
                )}
          </p>
        </div>
        {!input.startupSetup ? (
          <div className="settings-header-actions">
            <button
              type="button"
              className={`action-button${input.startupSetup ? " action-primary" : ""}`}
              disabled={!input.form || input.busy || input.checkingConnection}
              aria-busy={input.checkingConnection}
              onClick={() => void input.onCheckConnection()}
            >
              {input.checkingConnection
                ? t("Testing...", "检测中...")
                : t("Test connection", "检测连接")}
            </button>
            <button
              type="button"
              className="action-button action-primary"
              disabled={!input.form || input.busy || input.checkingConnection}
              onClick={input.onSave}
            >
              {t("Save changes", "保存更改")}
            </button>
          </div>
        ) : null}
      </div>

      {input.startupSetup ? (
        <div
          className={`llm-startup-callout${allRuntimeDependenciesReady ? " is-ready" : ""}`}
          role="status"
        >
          <span className="llm-startup-callout-mark" aria-hidden="true" />
          <div>
            <strong>
              {allRuntimeDependenciesReady
                ? t("All local tools are ready", "所有本地工具均已就绪")
                : t("Preparing your workspace", "正在准备你的工作空间")}
            </strong>
            <p>
              {t(
                "AI worker, Learning Mode, and browser automation continue in parallel while you configure your model.",
                "AI Worker、Learning Mode 与浏览器自动化会并行准备；你可以同时完成模型配置。",
              )}
            </p>
            <div className="llm-startup-runtime-list">
              {input.runtimePreparation.dependencies.map((dependency) => (
                <div className="llm-startup-runtime-item" key={dependency.id}>
                  <div className="llm-startup-runtime-heading">
                    <span>
                      {startupDependencyLabel(dependency.id, input.language)}
                    </span>
                    <span
                      className={`llm-startup-runtime-state runtime-${dependency.phase}`}
                    >
                      {startupDependencyPhaseLabel(
                        dependency.phase,
                        input.language,
                      )}
                    </span>
                  </div>
                  <div
                    className={`llm-startup-progress runtime-${dependency.phase}`}
                    role="progressbar"
                    aria-label={startupDependencyLabel(
                      dependency.id,
                      input.language,
                    )}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={dependency.phase === "ready" ? 100 : 38}
                  >
                    <span />
                  </div>
                </div>
              ))}
            </div>
            {runtimeNeedsAttention ? (
              <button
                type="button"
                className="action-button"
                onClick={input.onRetryRuntimePreparation}
              >
                {t("Retry local tools", "重试本地工具")}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {form ? (
        <>
          <fieldset
            className="settings-fieldset"
            disabled={input.busy || input.checkingConnection}
          >
            <div className="llm-settings-groups">
              <section className="settings-form-group">
                <div className="settings-form-group-header">
                  <h4>{t("Connection", "连接")}</h4>
                  <p>
                    {t(
                      "Where requests are sent and how this connection authenticates.",
                      "设置请求发送位置和连接认证方式。",
                    )}
                  </p>
                </div>
                <div
                  className={`form-grid${input.startupSetup ? " startup-llm-connection-grid" : ""}`}
                >
                  <label className="form-field startup-llm-provider-field">
                    <span>{t("Provider label", "服务商标签")}</span>
                    <select
                      value={form.providerPreset}
                      onChange={(event) =>
                        input.onUpdateField(
                          "providerPreset",
                          event.target.value as LlmFormState["providerPreset"],
                        )
                      }
                    >
                      {LLM_PROVIDER_PRESET_OPTIONS.map((option) => (
                        <option
                          key={option.value || "not-set"}
                          value={option.value}
                        >
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {form.providerPreset === "custom" ? (
                    <label className="form-field startup-llm-custom-provider-field">
                      <span>{t("Custom provider", "自定义服务商")}</span>
                      <input
                        value={form.customProvider}
                        onChange={(event) =>
                          input.onUpdateField(
                            "customProvider",
                            event.target.value,
                          )
                        }
                        placeholder="custom-gateway"
                      />
                    </label>
                  ) : null}
                  <label className="form-field form-field-wide startup-llm-base-url-field">
                    <span>Base URL</span>
                    <input
                      value={form.baseUrl}
                      onChange={(event) =>
                        input.onUpdateField("baseUrl", event.target.value)
                      }
                      placeholder="https://api.openai.com/v1"
                    />
                  </label>
                  <label className="form-field startup-llm-api-format-field">
                    <span>{t("API format", "API 格式")}</span>
                    <select
                      value={form.wireApi}
                      onChange={(event) =>
                        input.onUpdateField(
                          "wireApi",
                          event.target.value as LlmFormState["wireApi"],
                        )
                      }
                    >
                      <option value="responses">Responses API</option>
                      <option value="chat-completions">
                        Chat Completions API
                      </option>
                    </select>
                  </label>
                  <label className="form-field startup-llm-auth-field">
                    <span>{t("Authentication", "认证方式")}</span>
                    <select
                      value={form.authMode}
                      onChange={(event) =>
                        input.onUpdateField(
                          "authMode",
                          event.target.value as LlmFormState["authMode"],
                        )
                      }
                    >
                      <option value="direct">
                        {t("Stored API key", "已保存的 API Key")}
                      </option>
                      <option value="env">
                        {t("Environment variable", "环境变量")}
                      </option>
                      <option value="none">
                        {t("No API key", "无 API Key")}
                      </option>
                    </select>
                  </label>
                  {form.authMode === "direct" ? (
                    <label className="form-field form-field-wide">
                      <span>API Key</span>
                      <input
                        type="password"
                        value={form.apiKey}
                        onChange={(event) =>
                          input.onUpdateField("apiKey", event.target.value)
                        }
                        placeholder={
                          form.hasStoredApiKey
                            ? t(
                                "Leave blank to keep the current key",
                                "留空以保留当前密钥",
                              )
                            : "sk-..."
                        }
                      />
                    </label>
                  ) : null}
                  {form.authMode === "env" ? (
                    <label className="form-field form-field-wide">
                      <span>{t("API key variable", "API Key 变量名")}</span>
                      <input
                        value={form.apiKeyEnv}
                        onChange={(event) =>
                          input.onUpdateField("apiKeyEnv", event.target.value)
                        }
                        placeholder="e.g. LLM_API_KEY"
                      />
                    </label>
                  ) : null}
                </div>
                {input.startupSetup ? (
                  <div className="startup-llm-test-row">
                    <div
                      className={`startup-llm-test-status${input.startupConnectionReady ? " is-ready" : ""}`}
                      role="status"
                    >
                      <span aria-hidden="true" />
                      <div>
                        <strong>
                          {input.startupConnectionReady
                            ? t("LLM connection ready", "LLM 连接已就绪")
                            : t("Test your LLM configuration", "检测 LLM 配置")}
                        </strong>
                        <small>
                          {input.startupConnectionReady
                            ? t("Connection test passed.", "连接检测已通过。")
                            : t(
                                "Saves these fields and verifies a real model request.",
                                "保存当前字段并验证一次真实模型请求。",
                              )}
                        </small>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="action-button action-primary"
                      disabled={
                        !input.form || input.busy || input.checkingConnection
                      }
                      aria-busy={input.checkingConnection}
                      onClick={() => void input.onCheckConnection()}
                    >
                      {input.checkingConnection
                        ? t("Testing LLM...", "正在检测 LLM...")
                        : t("Test LLM", "检测 LLM")}
                    </button>
                  </div>
                ) : null}
              </section>

              <section className="settings-form-group">
                <div className="settings-form-group-header">
                  <h4>{t("Model defaults", "模型默认设置")}</h4>
                  <p>
                    {input.startupSetup
                      ? t(
                          "Choose the model this workspace should use.",
                          "选择这个工作空间要使用的模型。",
                        )
                      : t(
                          "Choose the model and shared execution limits.",
                          "选择模型以及共享的推理和等待策略。",
                        )}
                  </p>
                </div>
                <div className="form-grid llm-model-defaults-grid">
                  <div className="form-field form-field-wide llm-model-picker">
                    <div className="llm-model-picker-heading">
                      <span>{t("Model", "模型")}</span>
                      <button
                        type="button"
                        className="llm-model-refresh-button"
                        disabled={
                          !form.baseUrl.trim() ||
                          input.modelsLoading ||
                          input.busy ||
                          input.checkingConnection
                        }
                        aria-busy={input.modelsLoading}
                        onClick={() => void input.onLoadModels()}
                      >
                        {input.modelsLoading
                          ? t("Loading...", "获取中...")
                          : input.modelsLoaded
                            ? t("Refresh models", "刷新模型")
                            : t("Fetch models", "获取模型")}
                      </button>
                    </div>
                    <select
                      aria-label={t("Model", "模型")}
                      value={modelSelectValue}
                      disabled={input.modelsLoading}
                      onChange={(event) => {
                        const choice = event.target.value;
                        if (choice === "custom") {
                          input.onUpdateField("modelPreset", "custom");
                          input.onUpdateField("customModel", "");
                          return;
                        }
                        const model = choice.slice("model:".length);
                        const preset = detectLlmModelPreset(model);
                        input.onUpdateField("modelPreset", preset);
                        input.onUpdateField(
                          "customModel",
                          preset === "custom" ? model : "",
                        );
                      }}
                    >
                      {modelOptions.map((option) => (
                        <option
                          key={option.value}
                          value={`model:${option.value}`}
                        >
                          {option.label}
                        </option>
                      ))}
                      <option value="custom">{t("Custom", "自定义")}</option>
                    </select>
                    <div
                      className={`llm-model-discovery-status${input.modelsError ? " is-error" : ""}`}
                      role={input.modelsError ? "alert" : "status"}
                      aria-live="polite"
                    >
                      {input.modelsLoading
                        ? t(
                            "Loading models from the Base URL...",
                            "正在从 Base URL 获取模型...",
                          )
                        : input.modelsError
                          ? t(
                              `Unable to load models: ${input.modelsError}`,
                              `获取模型失败：${input.modelsError}`,
                            )
                          : input.modelsLoaded &&
                              input.availableModels.length === 0
                            ? t(
                                "No models were returned. Enter a model manually.",
                                "服务端未返回模型，请手动填写。",
                              )
                            : input.modelsLoaded && !selectedModelIsAvailable
                              ? t(
                                  "The current model was not returned. You can keep or edit it.",
                                  "服务端未返回当前模型，你可以保留或修改它。",
                                )
                              : input.modelsLoaded
                                ? t(
                                    `${input.availableModels.length} models loaded from the Base URL.`,
                                    `已从 Base URL 获取 ${input.availableModels.length} 个模型。`,
                                  )
                                : t(
                                    "Fetch the models exposed by this Base URL.",
                                    "从当前 Base URL 获取可用模型。",
                                  )}
                    </div>
                  </div>
                  {showCustomModel ? (
                    <label className="form-field form-field-wide llm-custom-model-field">
                      <span>{t("Custom model", "自定义模型")}</span>
                      <input
                        value={customModelValue}
                        onChange={(event) => {
                          input.onUpdateField("modelPreset", "custom");
                          input.onUpdateField(
                            "customModel",
                            event.target.value,
                          );
                        }}
                        placeholder="gpt-5.4"
                      />
                    </label>
                  ) : null}
                  {!input.startupSetup ? (
                    <>
                      <label className="form-field llm-model-default-control">
                        <span>{t("Reasoning effort", "推理强度")}</span>
                        <select
                          value={globalReasoningOption}
                          onChange={(event) => {
                            const nextValue = event.target
                              .value as LlmGlobalReasoningOption;
                            if (
                              nextValue ===
                              LLM_CUSTOMIZED_REASONING_OPTION.value
                            ) {
                              input.onUpdateField(
                                "advancedReasoningConfigEnabled",
                                true,
                              );
                              return;
                            }
                            input.onUpdateField("reasoningEffort", nextValue);
                            input.onUpdateField(
                              "advancedReasoningConfigEnabled",
                              false,
                            );
                            clearAdvancedLlmProfileOverrides(
                              "reasoningEffort",
                              input.onUpdateCallProfileField,
                            );
                            setAdvancedDialog((previous) =>
                              previous === "reasoning" ? null : previous,
                            );
                          }}
                        >
                          {LLM_REASONING_EFFORT_OPTIONS.map((option) => (
                            <option key={option.label} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                          <option value={LLM_CUSTOMIZED_REASONING_OPTION.value}>
                            {t("Advanced per stage", "按阶段高级设置")}
                          </option>
                        </select>
                      </label>
                      <label className="form-field llm-model-default-control">
                        <span>{t("Timeout behavior", "超时策略")}</span>
                        <select
                          aria-label={t("Timeout behavior", "超时策略")}
                          value={timeoutConfigOption}
                          onChange={(event) => {
                            const nextValue = event.target
                              .value as LlmTimeoutConfigOption;
                            if (nextValue === "advanced") {
                              input.onUpdateField(
                                "advancedTimeoutConfigEnabled",
                                true,
                              );
                              if (
                                parseResponseReadTimeoutMs(
                                  form.responseReadTimeoutMs,
                                ) === null
                              ) {
                                input.onUpdateField(
                                  "responseReadTimeoutMs",
                                  String(LLM_SIMPLE_TIMEOUT_MS),
                                );
                              }
                              return;
                            }
                            input.onUpdateField(
                              "advancedTimeoutConfigEnabled",
                              false,
                            );
                            input.onUpdateField(
                              "responseReadTimeoutMs",
                              String(LLM_SIMPLE_TIMEOUT_MS),
                            );
                            input.onUpdateField(
                              "responseTimeoutMode",
                              nextValue === "request-start" ? "fixed" : "idle",
                            );
                            clearAdvancedLlmProfileOverrides(
                              "responseReadTimeoutMs",
                              input.onUpdateCallProfileField,
                            );
                            setAdvancedDialog((previous) =>
                              previous === "timeout" ? null : previous,
                            );
                          }}
                        >
                          <option value="streaming-output">
                            {t("Reset while streaming", "流式输出时重置计时")}
                          </option>
                          <option value="request-start">
                            {t("180s from request start", "请求开始后 180 秒")}
                          </option>
                          <option value="advanced">
                            {t("Advanced per stage", "按阶段高级设置")}
                          </option>
                        </select>
                      </label>
                    </>
                  ) : null}
                </div>
              </section>

              {!input.startupSetup ? (
                <section className="settings-form-group settings-form-group-compact">
                  <div className="settings-form-group-header">
                    <h4>{t("Advanced", "高级设置")}</h4>
                    <p>
                      {t(
                        "Keep the compatibility profile at Default unless your gateway requires another client format.",
                        "除非模型网关要求其他客户端格式，否则请保留默认兼容模式。",
                      )}
                    </p>
                  </div>
                  <div className="form-grid llm-advanced-grid">
                    <label className="form-field form-field-wide">
                      <span>{t("Compatibility profile", "兼容模式")}</span>
                      <select
                        value={form.clientProfile}
                        onChange={(event) =>
                          input.onUpdateField(
                            "clientProfile",
                            event.target.value as LlmFormState["clientProfile"],
                          )
                        }
                      >
                        {LLM_CLIENT_PROFILE_OPTIONS.map((option) => (
                          <option
                            key={option.value || "default"}
                            value={option.value}
                          >
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="llm-advanced-action">
                      <div>
                        <strong>
                          {t("Per-stage reasoning", "分阶段推理强度")}
                        </strong>
                        <small>
                          {t(
                            "Override reasoning for selected generation stages.",
                            "为指定生成阶段单独设置推理强度。",
                          )}
                        </small>
                      </div>
                      <button
                        type="button"
                        className="action-button action-secondary"
                        disabled={!form.advancedReasoningConfigEnabled}
                        onClick={() => setAdvancedDialog("reasoning")}
                      >
                        {t("Configure", "配置")}
                      </button>
                    </div>
                    <div className="llm-advanced-action">
                      <div>
                        <strong>{t("Per-stage timeouts", "分阶段超时")}</strong>
                        <small>
                          {t(
                            "Set waiting limits for selected generation stages.",
                            "为指定生成阶段设置等待时限。",
                          )}
                        </small>
                      </div>
                      <button
                        type="button"
                        className="action-button action-secondary"
                        disabled={!form.advancedTimeoutConfigEnabled}
                        onClick={() => setAdvancedDialog("timeout")}
                      >
                        {t("Configure", "配置")}
                      </button>
                    </div>
                  </div>
                </section>
              ) : null}
            </div>

            {form.authMode === "direct" && form.hasStoredApiKey ? (
              <p className="inline-note">
                {t(
                  "A direct API key is already stored. Leave the field blank to keep it.",
                  "已保存 API Key。留空即可保留当前密钥。",
                )}
              </p>
            ) : null}
            {input.connectionError ? (
              <p className="inline-error">
                {t("Connection test failed", "连接检测失败")}:{" "}
                {input.connectionError}
              </p>
            ) : null}
            {input.errorMessage ? (
              <p className="inline-error">
                {t("Could not refresh model settings", "无法刷新模型设置")}:{" "}
                {input.errorMessage}
              </p>
            ) : null}
            {input.feedback ? (
              <p className="inline-note" role="status">
                {input.feedback}
              </p>
            ) : null}
          </fieldset>

          <AdvancedConfigDialog
            open={
              form.advancedTimeoutConfigEnabled && advancedDialog === "timeout"
            }
            dialogTitle={t("Per-stage timeouts", "分阶段超时")}
            dialogDescription={t(
              "Tune the waiting strategy and optional per-stage timeouts for workflow and skill generation.",
              "调整工作流与技能生成的等待策略，以及可选的分阶段超时。",
            )}
            titleId="advanced-timeout-config-title"
            onClose={() => setAdvancedDialog(null)}
          >
            <fieldset className="settings-fieldset" disabled={input.busy}>
              <div className="form-grid">
                <label className="form-field">
                  <span>{t("Waiting strategy", "等待策略")}</span>
                  <select
                    aria-label={t("Waiting strategy", "等待策略")}
                    value={form.responseTimeoutMode}
                    onChange={(event) =>
                      input.onUpdateField(
                        "responseTimeoutMode",
                        event.target.value as LabLlmResponseTimeoutMode,
                      )
                    }
                  >
                    <option value="idle">
                      {t(
                        "Continue while the model is streaming",
                        "模型持续流式输出时继续等待",
                      )}
                    </option>
                    <option value="fixed">
                      {t(
                        "Start timing when the request begins",
                        "请求开始时启动超时计时",
                      )}
                    </option>
                  </select>
                </label>
              </div>
              <div className="call-profile-grid settings-dialog-grid">
                {LLM_CALL_PROFILE_FIELDS.map((field) => (
                  <article className="call-profile-card" key={field.key}>
                    <h5>{t(field.label.en, field.label.zh)}</h5>
                    <label className="form-field">
                      <span>
                        {t(field.label.en, field.label.zh)}{" "}
                        {t("timeout (ms)", "超时（毫秒）")}
                      </span>
                      <input
                        inputMode="numeric"
                        value={
                          form.callProfiles[field.key].responseReadTimeoutMs
                        }
                        onChange={(event) =>
                          input.onUpdateCallProfileField(
                            field.key,
                            "responseReadTimeoutMs",
                            event.target.value,
                          )
                        }
                        placeholder={t(
                          "Leave blank to use the shared timeout",
                          "留空以使用共享超时",
                        )}
                      />
                    </label>
                  </article>
                ))}
              </div>
            </fieldset>
          </AdvancedConfigDialog>

          <AdvancedConfigDialog
            open={
              form.advancedReasoningConfigEnabled &&
              advancedDialog === "reasoning"
            }
            dialogTitle={t("Per-stage reasoning", "分阶段推理强度")}
            dialogDescription={t(
              "Override the shared reasoning effort for specific workflow and skill-generation stages when you need finer control.",
              "需要更精细控制时，可为特定工作流与技能生成阶段覆盖共享推理强度。",
            )}
            titleId="advanced-reasoning-effort-title"
            onClose={() => setAdvancedDialog(null)}
          >
            <fieldset className="settings-fieldset" disabled={input.busy}>
              <div className="call-profile-grid settings-dialog-grid">
                {LLM_CALL_PROFILE_FIELDS.map((field) => (
                  <article className="call-profile-card" key={field.key}>
                    <h5>{t(field.label.en, field.label.zh)}</h5>
                    <label className="form-field">
                      <span>
                        {t(field.label.en, field.label.zh)}{" "}
                        {t("reasoning", "推理强度")}
                      </span>
                      <select
                        value={form.callProfiles[field.key].reasoningEffort}
                        onChange={(event) =>
                          input.onUpdateCallProfileField(
                            field.key,
                            "reasoningEffort",
                            event.target.value,
                          )
                        }
                      >
                        <option value="">
                          {t(
                            "Inherit shared reasoning effort",
                            "继承共享推理强度",
                          )}
                        </option>
                        {LLM_REASONING_EFFORT_OPTIONS.map((option) => (
                          <option key={option.label} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </article>
                ))}
              </div>
            </fieldset>
          </AdvancedConfigDialog>
        </>
      ) : input.errorMessage ? (
        <>
          <p className="inline-error">
            {t("Failed to load model settings", "模型设置加载失败")}:{" "}
            {input.errorMessage}
          </p>
          <button
            className="action-button"
            disabled={input.busy}
            onClick={input.onRetry}
          >
            {t("Retry", "重试")}
          </button>
        </>
      ) : input.loading ? (
        <div className="settings-loading-state" role="status">
          <span />
          <span />
          <span />
          <p>{t("Loading model settings...", "正在加载模型设置...")}</p>
        </div>
      ) : (
        <>
          <p className="empty-copy">
            {t(
              "Model settings have not been loaded yet.",
              "模型设置尚未加载。",
            )}
          </p>
          <button
            className="action-button"
            disabled={input.busy}
            onClick={input.onRetry}
          >
            {t("Load settings", "加载设置")}
          </button>
        </>
      )}
    </section>
  );
}

/**
 * EN: Formats one recorder language label for display.
 * @param language configured OCR language.
 * @param displayLanguage active app display language.
 * @returns display label.
 */
export function formatRecorderLanguageLabel(
  language: LabScreenpipeLanguage,
  displayLanguage: AppLanguage = "en",
): string {
  if (displayLanguage === "zh") {
    const zhLabels: Partial<Record<LabScreenpipeLanguage, string>> = {
      chinese: "中文",
      english: "英文",
      japanese: "日文",
    };
    const zhLabel = zhLabels[language];
    if (zhLabel) {
      return zhLabel;
    }
  }

  return language.charAt(0).toUpperCase() + language.slice(1);
}

/**
 * EN: Formats recorder OCR priority into one compact summary line.
 * @param priority active recorder language priority.
 * @param displayLanguage active app display language.
 * @returns summary string for the main UI.
 */
export function formatRecorderLanguageSummary(
  priority: readonly LabScreenpipeLanguage[],
  displayLanguage: AppLanguage = "en",
): string {
  const slots: RecorderLanguageSlotValue[] = Array.from(
    {
      length: RECORDER_LANGUAGE_PRIORITY_SLOT_COUNT,
    },
    (_, index) => priority[index] ?? "",
  );
  return slots
    .map((value) =>
      value === ""
        ? SETTINGS_COPY[displayLanguage].recorder.notSetLabel
        : formatRecorderLanguageLabel(value, displayLanguage),
    )
    .join(" -> ");
}

function buildFallbackPermissionItems(): RecorderPermissionItem[] {
  return [
    {
      kind: "screen-recording",
      label: "Screen Recording",
      description:
        "Lets OysterWorkflow read screen content so it can capture steps and visible text.",
      state: "unknown",
      detail: "We have not confirmed this permission yet.",
    },
    {
      kind: "accessibility",
      label: "Accessibility",
      description:
        "Lets OysterWorkflow notice app switches and UI changes while you work.",
      state: "unknown",
      detail: "We have not confirmed this permission yet.",
    },
    {
      kind: "input-monitoring",
      label: "Input Monitoring",
      description:
        "Lets OysterWorkflow capture keyboard and pointer activity so recorded steps stay in sync.",
      state: "unknown",
      detail: "We have not confirmed this permission yet.",
    },
    {
      kind: "microphone",
      label: "Microphone",
      description:
        "Lets OysterWorkflow capture spoken narration so it can transcribe your workflow commentary.",
      state: "unknown",
      detail: "We have not confirmed this permission yet.",
    },
  ];
}

function formatPermissionState(state: RecorderPermissionItem["state"]): string {
  switch (state) {
    case "granted":
      return "Granted";
    case "missing":
      return "Missing";
    case "unknown":
      return "Checking";
  }
}

function formatStartupPermissionState(
  state: RecorderPermissionItem["state"],
  language: AppLanguage,
): string {
  if (language === "en") {
    return formatPermissionState(state);
  }
  switch (state) {
    case "granted":
      return "已允许";
    case "missing":
      return "未允许";
    case "unknown":
      return "检测中";
  }
}

function startupPermissionLabel(
  kind: RecorderPermissionKind,
  language: AppLanguage,
): string {
  const labels: Record<RecorderPermissionKind, [string, string]> = {
    "screen-recording": ["Screen Recording", "屏幕录制"],
    accessibility: ["Accessibility", "辅助功能"],
    "input-monitoring": ["Input Monitoring", "输入监控"],
    microphone: ["Microphone", "麦克风"],
  };
  return labels[kind][language === "zh" ? 1 : 0];
}

function startupPermissionDescription(
  kind: RecorderPermissionKind,
  language: AppLanguage,
): string {
  const descriptions: Record<RecorderPermissionKind, [string, string]> = {
    "screen-recording": [
      "Lets Learning Mode understand visible workflow steps.",
      "让 Learning Mode 理解屏幕上可见的工作流步骤。",
    ],
    accessibility: [
      "Lets Learning Mode observe app and interface changes.",
      "让 Learning Mode 感知应用切换与界面变化。",
    ],
    "input-monitoring": [
      "Keeps keyboard and pointer activity aligned with recorded steps.",
      "让键盘与鼠标活动和录制步骤保持同步。",
    ],
    microphone: [
      "Captures spoken explanations when audio learning is enabled.",
      "启用音频学习时，用于捕捉口头说明。",
    ],
  };
  return descriptions[kind][language === "zh" ? 1 : 0];
}

function startupDependencyLabel(
  id: StartupDependencyId,
  language: AppLanguage,
): string {
  const labels: Record<StartupDependencyId, [string, string]> = {
    hermes: ["AI worker", "AI Worker"],
    screenpipe: ["Learning Mode", "Learning Mode"],
    browser: ["Browser automation", "浏览器自动化"],
  };
  return labels[id][language === "zh" ? 1 : 0];
}

function startupDependencyPhaseLabel(
  phase: StartupRuntimePreparationStatus["dependencies"][number]["phase"],
  language: AppLanguage,
): string {
  const labels: Record<typeof phase, [string, string]> = {
    preparing: ["Preparing", "准备中"],
    ready: ["Ready", "已就绪"],
    attention: ["Needs attention", "需要处理"],
  };
  return labels[phase][language === "zh" ? 1 : 0];
}

function getPermissionActionLabel(
  item: RecorderPermissionItem,
  requestingKind: RecorderPermissionKind | null,
): string {
  if (item.state === "granted") {
    return "Granted";
  }
  if (requestingKind === item.kind) {
    return "Requesting...";
  }
  return "Request Permission";
}
