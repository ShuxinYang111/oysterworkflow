import { createHash, randomUUID } from "node:crypto";

/**
 * EN: Creates the durable identity for one local OysterWorkflow installation.
 * 中文: 为单个 OysterWorkflow 本地安装创建持久身份。
 * @returns a globally unique installation identifier.
 */
export function createInstallationId(): string {
  return randomUUID();
}

/**
 * EN: Creates a globally unique entity id while retaining a readable prefix.
 * 中文: 创建全局唯一实体 ID，同时保留可读前缀。
 * @param prefix stable entity type prefix.
 * @param readableHint optional user-facing hint such as a worker name.
 * @returns prefixed id with a UUID suffix.
 */
export function createProductEntityId(
  prefix: string,
  readableHint?: string | null,
): string {
  const normalizedPrefix = normalizeIdentitySegment(prefix) || "entity";
  const normalizedHint = normalizeIdentitySegment(readableHint ?? "").slice(
    0,
    48,
  );
  return [normalizedPrefix, normalizedHint, randomUUID()]
    .filter(Boolean)
    .join("-");
}

/**
 * EN: Builds a collision-resistant local namespace for an account on this installation.
 * 中文: 为当前安装中的账号构建抗碰撞本地命名空间。
 * @param installationId durable per-install identity.
 * @param accountId local or cloud account identity.
 * @returns filesystem/provider-safe namespace segment.
 */
export function installationAccountNamespace(
  installationId: string,
  accountId: string,
): string {
  const digest = createHash("sha256")
    .update(`${installationId}\0${accountId}`)
    .digest("hex")
    .slice(0, 20);
  return `install-${normalizeIdentitySegment(installationId).slice(0, 12)}-account-${digest}`;
}

function normalizeIdentitySegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}
