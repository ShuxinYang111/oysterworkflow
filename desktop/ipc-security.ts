export interface IpcSenderLike {
  id: number;
}

export interface IpcInvokeEventLike {
  sender: IpcSenderLike;
}

export interface TrustedWindowLike {
  isDestroyed: () => boolean;
  webContents: IpcSenderLike;
}

/**
 * EN: Restricts privileged IPC handlers to the current primary BrowserWindow.
 * 中文: 将高权限 IPC handler 限制为当前主 BrowserWindow 调用。
 * @param event Electron invoke event or a structural test double.
 * @param trustedWindow current primary window.
 * @returns void; throws when sender identity is not trusted.
 */
export function assertTrustedIpcSender(
  event: IpcInvokeEventLike,
  trustedWindow: TrustedWindowLike | null,
): void {
  if (
    !trustedWindow ||
    trustedWindow.isDestroyed() ||
    event.sender.id !== trustedWindow.webContents.id
  ) {
    throw new Error("IPC request rejected: untrusted renderer.");
  }
}
