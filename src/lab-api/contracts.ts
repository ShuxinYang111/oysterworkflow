export * from "./api-contracts.js";

export interface LabProcessExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface LabProcessHandle {
  pid: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  onceExit(): Promise<LabProcessExitResult>;
  onExit(listener: (result: LabProcessExitResult) => void): void;
}
