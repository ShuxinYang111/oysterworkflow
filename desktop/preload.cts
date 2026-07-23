import { contextBridge, ipcRenderer } from "electron";
import type {
  RecorderPermissionKind,
  RecorderPermissionsResponse,
} from "../src/lab-api/api-contracts.js";
import type {
  CloudAuthActionResponse,
  CloudAuthState,
  CloudEmailAuthInput,
  CloudIpcRequestOptions,
  CloudSignUpResponse,
  CloudRuntimeRequestInput,
  CloudRuntimeRequestResponse,
  CloudSyncMode,
  CloudSyncResult,
} from "../src/cloud/contracts.js";
import type { DesktopUpdateSnapshot } from "../src/desktop-update/contracts.js";

interface RuntimeBridgePayload {
  apiBaseUrl: string;
  platform: string;
  mode: string;
}

const bridgePayload: RuntimeBridgePayload = {
  apiBaseUrl: readArgumentValue("oysterworkflow-api-base-url"),
  platform: readArgumentValue("oysterworkflow-platform") || process.platform,
  mode: readArgumentValue("oysterworkflow-mode") || "desktop",
};

contextBridge.exposeInMainWorld("oysterworkflow", {
  runtime: bridgePayload,
  desktop: {
    openPermissionSettings: (kind: RecorderPermissionKind) =>
      ipcRenderer.invoke("oysterworkflow:open-permission-settings", kind),
    checkRecorderPermissions: (): Promise<RecorderPermissionsResponse> =>
      ipcRenderer.invoke("oysterworkflow:check-recorder-permissions"),
    requestRecorderPermission: (
      kind: RecorderPermissionKind,
    ): Promise<boolean> =>
      ipcRenderer.invoke("oysterworkflow:request-recorder-permission", kind),
    requestMicrophoneAccess: (): Promise<boolean> =>
      ipcRenderer.invoke("oysterworkflow:request-microphone-access"),
    quitAndReopen: (): Promise<boolean> =>
      ipcRenderer.invoke("oysterworkflow:quit-and-reopen"),
    openExternalUrl: (url: string): Promise<void> =>
      ipcRenderer.invoke("oysterworkflow:open-external-url", url),
    getUpdateState: (): Promise<DesktopUpdateSnapshot> =>
      ipcRenderer.invoke("oysterworkflow:update-get-state"),
    checkForUpdates: (): Promise<DesktopUpdateSnapshot> =>
      ipcRenderer.invoke("oysterworkflow:update-check"),
    downloadUpdate: (): Promise<DesktopUpdateSnapshot> =>
      ipcRenderer.invoke("oysterworkflow:update-download"),
    installUpdate: (): Promise<DesktopUpdateSnapshot> =>
      ipcRenderer.invoke("oysterworkflow:update-install"),
    onUpdateStateChanged: (
      listener: (snapshot: DesktopUpdateSnapshot) => void,
    ) => {
      const wrapped = (
        _event: Electron.IpcRendererEvent,
        snapshot: DesktopUpdateSnapshot,
      ) => listener(snapshot);
      ipcRenderer.on("oysterworkflow:update-state-changed", wrapped);
      return () => {
        ipcRenderer.removeListener(
          "oysterworkflow:update-state-changed",
          wrapped,
        );
      };
    },
  },
  auth: {
    getState: (): Promise<CloudAuthState> =>
      ipcRenderer.invoke("oysterworkflow:auth-get-state"),
    signUp: (input: CloudEmailAuthInput): Promise<CloudSignUpResponse> =>
      ipcRenderer.invoke("oysterworkflow:auth-sign-up", input),
    signIn: (input: CloudEmailAuthInput): Promise<CloudAuthActionResponse> =>
      ipcRenderer.invoke("oysterworkflow:auth-sign-in", input),
    continueWithGoogle: (): Promise<CloudAuthActionResponse> =>
      ipcRenderer.invoke("oysterworkflow:auth-google"),
    signOut: (): Promise<CloudAuthActionResponse> =>
      ipcRenderer.invoke("oysterworkflow:auth-sign-out"),
    onStateChanged: (listener: (state: CloudAuthState) => void) => {
      const wrapped = (
        _event: Electron.IpcRendererEvent,
        state: CloudAuthState,
      ) => listener(state);
      ipcRenderer.on("oysterworkflow:auth-state-changed", wrapped);
      return () => {
        ipcRenderer.removeListener(
          "oysterworkflow:auth-state-changed",
          wrapped,
        );
      };
    },
    onError: (listener: (message: string) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, message: string) =>
        listener(message);
      ipcRenderer.on("oysterworkflow:auth-error", wrapped);
      return () => {
        ipcRenderer.removeListener("oysterworkflow:auth-error", wrapped);
      };
    },
  },
  cloud: {
    sync: (
      mode: CloudSyncMode = "pull",
      options?: CloudIpcRequestOptions,
    ): Promise<CloudSyncResult> =>
      ipcRenderer.invoke("oysterworkflow:cloud-sync", mode, options),
    runtimeRequest: (
      input: CloudRuntimeRequestInput,
    ): Promise<CloudRuntimeRequestResponse> =>
      ipcRenderer.invoke("oysterworkflow:cloud-runtime-request", input),
    cancelRequest: (requestId: string): void =>
      ipcRenderer.send("oysterworkflow:cloud-cancel-request", requestId),
  },
});

function readArgumentValue(name: string): string {
  const prefix = `--${name}=`;
  const matched = process.argv.find((entry) => entry.startsWith(prefix));
  return matched ? matched.slice(prefix.length) : "";
}
