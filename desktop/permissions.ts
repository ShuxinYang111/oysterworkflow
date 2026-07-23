import { systemPreferences } from "electron";
import type {
  RecorderPermissionItem,
  RecorderPermissionState,
  RecorderPermissionsResponse,
} from "../src/lab-api/api-contracts.js";

const SCREEN_RECORDING_DESCRIPTION =
  "Lets OysterWorkflow read screen content so it can capture steps and visible text.";
const ACCESSIBILITY_DESCRIPTION =
  "Lets OysterWorkflow notice app switches and UI changes while you work.";
const INPUT_MONITORING_DESCRIPTION =
  "Lets OysterWorkflow capture keyboard and pointer activity so recorded steps stay in sync.";
const MICROPHONE_DESCRIPTION =
  "Lets OysterWorkflow capture spoken narration so it can transcribe your workflow commentary.";

type PermissionProbeResult = {
  state: RecorderPermissionState;
  detail: string;
};

/**
 * EN: Reads the packaged desktop app permission state directly from macOS without using Screenpipe.
 * @returns recorder permission summary for the current host app identity.
 */
export async function checkDesktopRecorderPermissions(): Promise<RecorderPermissionsResponse> {
  const checkedAt = new Date().toISOString();
  if (process.platform !== "darwin") {
    const summary = buildNonMacPermissionSummary();
    const items = buildPermissionItems({
      screenRecording: {
        state: "granted",
        detail: summary,
      },
      accessibility: {
        state: "granted",
        detail: summary,
      },
      inputMonitoring: {
        state: "granted",
        detail: summary,
      },
      microphone: {
        state: "granted",
        detail: summary,
      },
    });
    return {
      checkedAt,
      allGranted: true,
      canStartRecording: true,
      source: "not-needed",
      items,
      summary,
    };
  }

  const screenRecording = mapScreenRecordingPermission(
    systemPreferences.getMediaAccessStatus("screen"),
  );
  const accessibility = systemPreferences.isTrustedAccessibilityClient(false)
    ? {
        state: "granted" as const,
        detail: "",
      }
    : {
        state: "missing" as const,
        detail:
          "Turn on Accessibility in System Settings, then return here and refresh.",
      };
  const inputMonitoring: PermissionProbeResult = {
    state: "unknown",
    detail:
      "Open Input Monitoring in System Settings if recording cannot capture keyboard or pointer activity. OysterWorkflow verifies the real recorder capability when Learning Mode starts.",
  };
  const microphone = mapMicrophonePermission(
    systemPreferences.getMediaAccessStatus("microphone"),
  );

  const items = buildPermissionItems({
    screenRecording,
    accessibility,
    inputMonitoring,
    microphone,
  });
  const allGranted = items.every((item) => item.state === "granted");
  const canStartRecording = items.every((item) => item.state !== "missing");
  return {
    checkedAt,
    allGranted,
    canStartRecording,
    source: "host-app",
    items,
    summary: buildSummary({ allGranted, canStartRecording }),
  };
}

/**
 * EN: Requests microphone access for the packaged desktop app when macOS has not decided yet.
 * @returns whether microphone access is granted after the request attempt.
 */
export async function requestDesktopMicrophoneAccess(): Promise<boolean> {
  if (process.platform !== "darwin") {
    return true;
  }

  const currentStatus = systemPreferences.getMediaAccessStatus("microphone");
  if (currentStatus === "granted") {
    return true;
  }
  if (currentStatus === "denied" || currentStatus === "restricted") {
    return false;
  }

  return systemPreferences.askForMediaAccess("microphone");
}

function buildNonMacPermissionSummary(): string {
  return "";
}

function mapScreenRecordingPermission(
  status: ReturnType<typeof systemPreferences.getMediaAccessStatus>,
): PermissionProbeResult {
  switch (status) {
    case "granted":
      return {
        state: "granted",
        detail: "",
      };
    case "denied":
      return {
        state: "missing",
        detail:
          "Turn on Screen Recording in System Settings, then return here and refresh.",
      };
    case "restricted":
      return {
        state: "missing",
        detail:
          "Screen Recording is restricted on this Mac for the current app.",
      };
    case "not-determined":
      return {
        state: "missing",
        detail:
          "Turn on Screen Recording in System Settings, then return here and refresh.",
      };
    default:
      return {
        state: "unknown",
        detail: "We could not verify Screen Recording automatically.",
      };
  }
}

function mapMicrophonePermission(
  status: ReturnType<typeof systemPreferences.getMediaAccessStatus>,
): PermissionProbeResult {
  switch (status) {
    case "granted":
      return {
        state: "granted",
        detail: "",
      };
    case "denied":
      return {
        state: "missing",
        detail:
          "Turn on Microphone in System Settings, then return here and refresh.",
      };
    case "restricted":
      return {
        state: "missing",
        detail:
          "Microphone access is restricted on this Mac for the current app.",
      };
    case "not-determined":
      return {
        state: "missing",
        detail:
          "Allow Microphone access when macOS prompts for OysterWorkflow, then return here and refresh.",
      };
    default:
      return {
        state: "unknown",
        detail: "We could not verify Microphone automatically.",
      };
  }
}

function buildSummary(input: {
  allGranted: boolean;
  canStartRecording: boolean;
}): string {
  if (input.allGranted) {
    return "All required macOS permissions are available.";
  }
  if (input.canStartRecording) {
    return "Some permissions could not be verified automatically. Review the items below if you want to double-check them.";
  }
  return "Open the missing System Settings pages below, grant access, then return here and refresh.";
}

function buildPermissionItems(input: {
  screenRecording: {
    state: RecorderPermissionState;
    detail: string;
  };
  accessibility: {
    state: RecorderPermissionState;
    detail: string;
  };
  inputMonitoring: {
    state: RecorderPermissionState;
    detail: string;
  };
  microphone: {
    state: RecorderPermissionState;
    detail: string;
  };
}): RecorderPermissionItem[] {
  return [
    {
      kind: "screen-recording",
      label: "Screen Recording",
      description: SCREEN_RECORDING_DESCRIPTION,
      state: input.screenRecording.state,
      detail: input.screenRecording.detail,
    },
    {
      kind: "accessibility",
      label: "Accessibility",
      description: ACCESSIBILITY_DESCRIPTION,
      state: input.accessibility.state,
      detail: input.accessibility.detail,
    },
    {
      kind: "input-monitoring",
      label: "Input Monitoring",
      description: INPUT_MONITORING_DESCRIPTION,
      state: input.inputMonitoring.state,
      detail: input.inputMonitoring.detail,
    },
    {
      kind: "microphone",
      label: "Microphone",
      description: MICROPHONE_DESCRIPTION,
      state: input.microphone.state,
      detail: input.microphone.detail,
    },
  ];
}
