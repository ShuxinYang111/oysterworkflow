import type { CloudAuthUser } from "../../src/cloud/contracts.js";
import type { ProductAccount } from "../../src/product/contracts.js";

export interface AccountDisplayIdentity {
  name: string;
  email: string;
  initials: string;
  source: "cloud" | "local" | "loading";
}

/**
 * EN: Resolves the identity shown in account chrome without exposing stale demo data.
 * 中文: 解析账号区域展示身份，避免在云端账号加载期间暴露旧 demo 数据。
 * @param cloudUser authenticated Supabase user, when available.
 * @param localAccount local workspace profile used only as an offline fallback.
 * @returns identity safe to render from the first product frame.
 */
export function resolveAccountDisplayIdentity(
  cloudUser: CloudAuthUser | null,
  localAccount: ProductAccount | null,
): AccountDisplayIdentity {
  if (cloudUser) {
    const email = cloudUser.email.trim();
    const name = cloudUser.displayName?.trim() || displayNameFromEmail(email);
    return {
      name,
      email,
      initials: initialsForName(name),
      source: "cloud",
    };
  }

  if (localAccount) {
    const name = localAccount.name.trim() || "OysterWorkflow user";
    return {
      name,
      email: localAccount.email.trim(),
      initials: initialsForName(name),
      source: "local",
    };
  }

  return {
    name: "OysterWorkflow",
    email: "",
    initials: "OW",
    source: "loading",
  };
}

function displayNameFromEmail(email: string): string {
  const localPart = email.split("@", 1)[0]?.trim() ?? "";
  const words = localPart
    .split(/[._-]+/u)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length === 0) {
    return "OysterWorkflow user";
  }
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function initialsForName(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length > 1) {
    return `${words[0]?.charAt(0) ?? ""}${
      words[words.length - 1]?.charAt(0) ?? ""
    }`.toUpperCase();
  }
  return Array.from(words[0] ?? "OW")
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
