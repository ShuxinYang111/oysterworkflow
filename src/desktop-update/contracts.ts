export type DesktopUpdatePhase =
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up_to_date"
  | "installing"
  | "error";

export type DesktopUpdateErrorCode =
  "release_metadata_unavailable" | "network_unavailable" | "operation_failed";

export interface DesktopUpdateProgress {
  percent: number;
  transferredBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
}

export interface DesktopUpdateSnapshot {
  supported: boolean;
  phase: DesktopUpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  releaseName: string | null;
  releaseNotes: string | null;
  releaseDate: string | null;
  checkedAt: string | null;
  progress: DesktopUpdateProgress | null;
  errorMessage: string | null;
  errorCode?: DesktopUpdateErrorCode | null;
}
