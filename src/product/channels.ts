import type {
  ProductWorkerChannelConfig,
  ProductWorkerChannelInput,
  ProductWorkerChannelPlatform,
} from "./contracts.js";

export interface ProductWorkerChannelDefinition {
  platform: ProductWorkerChannelPlatform;
  label: string;
  setupMethod: "none" | "bot_token" | "app_tokens" | "qr_link";
  requiredCredentialKeys: string[];
  optionalCredentialKeys: string[];
}

export interface ProductWorkerChannelCredentialIssue {
  key: string;
  message: string;
}

export const PRODUCT_SLACK_APP_CREATOR_URL =
  "https://api.slack.com/apps?new_app=1";

const SLACK_CREDENTIAL_PREFIXES: Record<string, string> = {
  SLACK_BOT_TOKEN: "xoxb-",
  SLACK_APP_TOKEN: "xapp-",
};

const CHANNEL_DEFINITIONS: Record<
  ProductWorkerChannelPlatform,
  ProductWorkerChannelDefinition
> = {
  none: {
    platform: "none",
    label: "No channel",
    setupMethod: "none",
    requiredCredentialKeys: [],
    optionalCredentialKeys: [],
  },
  telegram: {
    platform: "telegram",
    label: "Telegram",
    setupMethod: "bot_token",
    requiredCredentialKeys: ["TELEGRAM_BOT_TOKEN"],
    optionalCredentialKeys: [
      "TELEGRAM_HOME_CHANNEL",
      "TELEGRAM_ALLOWED_USERS",
      "TELEGRAM_ALLOW_ALL_USERS",
    ],
  },
  slack: {
    platform: "slack",
    label: "Slack",
    setupMethod: "app_tokens",
    requiredCredentialKeys: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
    optionalCredentialKeys: [
      "SLACK_HOME_CHANNEL",
      "SLACK_ALLOWED_USERS",
      "SLACK_ALLOW_ALL_USERS",
    ],
  },
  weixin: {
    platform: "weixin",
    label: "WeChat",
    setupMethod: "qr_link",
    requiredCredentialKeys: [],
    optionalCredentialKeys: [
      "WEIXIN_ACCOUNT_ID",
      "WEIXIN_TOKEN",
      "WEIXIN_HOME_CHANNEL",
      "WEIXIN_ALLOWED_USERS",
      "WEIXIN_DM_POLICY",
      "WEIXIN_GROUP_POLICY",
    ],
  },
  whatsapp: {
    platform: "whatsapp",
    label: "WhatsApp",
    setupMethod: "qr_link",
    requiredCredentialKeys: [],
    optionalCredentialKeys: [
      "WHATSAPP_MODE",
      "WHATSAPP_ALLOWED_USERS",
      "WHATSAPP_ENABLED",
    ],
  },
  wecom: {
    platform: "wecom",
    label: "WeCom",
    setupMethod: "app_tokens",
    requiredCredentialKeys: ["WECOM_BOT_ID", "WECOM_SECRET"],
    optionalCredentialKeys: [
      "WECOM_WEBSOCKET_URL",
      "WECOM_HOME_CHANNEL",
      "WECOM_ALLOWED_USERS",
    ],
  },
};

/**
 * EN: Chooses whether a product binding targets one thread or an entire conversation.
 * 中文: 判断产品绑定应指向单个 thread 还是整个会话。
 * @param input observed conversation type and thread identifier.
 * @returns null for direct messages, otherwise the normalized thread id.
 */
export function productChannelBindingThreadId(input: {
  conversationType?: string | null;
  threadId?: string | null;
}): string | null {
  if (input.conversationType?.trim().toLowerCase() === "dm") {
    return null;
  }
  return input.threadId?.trim() || null;
}

/**
 * EN: Creates a stable not-configured channel shape for persisted workers.
 * 中文: 为持久化 worker 创建稳定的未配置渠道结构。
 * @param platform channel platform id.
 * @returns sanitized channel config.
 */
export function defaultProductWorkerChannelConfig(
  platform: ProductWorkerChannelPlatform = "none",
): ProductWorkerChannelConfig {
  const definition = CHANNEL_DEFINITIONS[platform] ?? CHANNEL_DEFINITIONS.none;
  return {
    platform: definition.platform,
    label: definition.label,
    accessMode: platform === "none" ? "disabled" : "allowlist",
    homeChannel: null,
    allowedUsers: [],
    configuredFields: [],
    missingFields: definition.requiredCredentialKeys,
    status: platform === "none" ? "not_configured" : "not_configured",
    lastTestedAt: null,
    lastError: null,
  };
}

/**
 * EN: Converts either the new structured channel input or old free-text channel into a channel input.
 * 中文: 将新的结构化渠道输入或旧版自由文本渠道转换为渠道输入。
 * @param input structured channel input.
 * @param legacyCommandChannel old free-text channel value.
 * @returns normalized channel input.
 */
export function normalizeProductWorkerChannelInput(
  input?: ProductWorkerChannelInput | null,
  legacyCommandChannel?: string | null,
): ProductWorkerChannelInput {
  if (input?.platform) {
    return {
      ...input,
      platform: normalizeChannelPlatform(input.platform),
    };
  }
  return {
    platform: platformFromLegacyChannel(legacyCommandChannel),
    accessMode: "allowlist",
    credentials: {},
  };
}

/**
 * EN: Builds the sanitized channel config stored in product state.
 * 中文: 构建写入产品状态的脱敏渠道配置。
 * @param input normalized channel input.
 * @param statusOverride optional status to preserve runtime test results.
 * @param lastTestedAt optional last-tested timestamp.
 * @param lastError optional test error.
 * @returns sanitized channel config.
 */
export function productWorkerChannelConfigFromInput(
  input: ProductWorkerChannelInput,
  statusOverride?: ProductWorkerChannelConfig["status"],
  lastTestedAt: string | null = null,
  lastError: string | null = null,
): ProductWorkerChannelConfig {
  const platform = normalizeChannelPlatform(input.platform);
  const definition = CHANNEL_DEFINITIONS[platform];
  const credentials = input.credentials ?? {};
  const configuredFields = [
    ...definition.requiredCredentialKeys,
    ...definition.optionalCredentialKeys,
  ].filter((key) => readCredential(credentials, key).length > 0);
  const missingFields = definition.requiredCredentialKeys.filter(
    (key) => readCredential(credentials, key).length === 0,
  );
  const status =
    statusOverride ??
    (platform === "none"
      ? "not_configured"
      : definition.setupMethod === "qr_link"
        ? "not_configured"
        : missingFields.length > 0
          ? "not_configured"
          : "configured");
  return {
    platform,
    label: definition.label,
    accessMode:
      platform === "none" ? "disabled" : (input.accessMode ?? "allowlist"),
    homeChannel: input.homeChannel?.trim() || null,
    allowedUsers: dedupeStrings(input.allowedUsers ?? []),
    configuredFields,
    missingFields,
    status,
    lastTestedAt,
    lastError,
  };
}

/**
 * EN: Normalizes a persisted channel object, including legacy missing values.
 * 中文: 规范化已持久化的渠道对象, 包括旧数据缺省值。
 * @param value raw channel config.
 * @param legacyCommandChannel optional old channel string.
 * @returns normalized channel config.
 */
export function normalizePersistedProductWorkerChannel(
  value: ProductWorkerChannelConfig | undefined,
  legacyCommandChannel?: string | null,
): ProductWorkerChannelConfig {
  if (!value) {
    const input = normalizeProductWorkerChannelInput(
      null,
      legacyCommandChannel,
    );
    return productWorkerChannelConfigFromInput(input);
  }
  const platform = normalizeChannelPlatform(value.platform);
  const definition = CHANNEL_DEFINITIONS[platform];
  return {
    ...defaultProductWorkerChannelConfig(platform),
    ...value,
    platform,
    label: definition.label,
    accessMode: platform === "none" ? "disabled" : value.accessMode,
    homeChannel: value.homeChannel?.trim() || null,
    allowedUsers: dedupeStrings(value.allowedUsers ?? []),
    configuredFields: dedupeStrings(value.configuredFields ?? []),
    missingFields: dedupeStrings(value.missingFields ?? []),
    lastTestedAt: value.lastTestedAt ?? null,
    lastError: value.lastError ?? null,
  };
}

/**
 * EN: Lists required credential keys for a channel platform.
 * 中文: 返回某个渠道平台所需的凭证字段。
 * @param platform channel platform id.
 * @returns required credential keys.
 */
export function requiredProductWorkerChannelCredentialKeys(
  platform: ProductWorkerChannelPlatform,
): string[] {
  return CHANNEL_DEFINITIONS[platform]?.requiredCredentialKeys ?? [];
}

/**
 * EN: Lists every credential/config key accepted from the renderer.
 * 中文: 返回 renderer 允许提交的全部渠道凭据/配置字段。
 * @param platform channel platform id.
 * @returns allowlisted credential and channel config keys.
 */
export function allowedProductWorkerChannelCredentialKeys(
  platform: ProductWorkerChannelPlatform,
): string[] {
  const definition = CHANNEL_DEFINITIONS[platform];
  return definition
    ? [
        ...definition.requiredCredentialKeys,
        ...definition.optionalCredentialKeys,
      ]
    : [];
}

/**
 * EN: Validates credential types without exposing their values.
 * 中文: 校验渠道凭据类型, 且不暴露凭据值。
 * @param platform channel platform id.
 * @param credentials channel credential values.
 * @returns actionable validation issues safe to show in the product UI.
 */
export function validateProductWorkerChannelCredentials(
  platform: ProductWorkerChannelPlatform,
  credentials: Record<string, string>,
): ProductWorkerChannelCredentialIssue[] {
  if (platform !== "slack") {
    return [];
  }
  return Object.entries(SLACK_CREDENTIAL_PREFIXES).flatMap(
    ([key, expectedPrefix]) => {
      const value = readCredential(credentials, key);
      if (!value || value.startsWith(expectedPrefix)) {
        return [];
      }
      return [
        {
          key,
          message:
            key === "SLACK_BOT_TOKEN"
              ? "Slack Bot token must start with xoxb-. Install the app to the workspace and copy the Bot User OAuth Token, not the App ID or Client Secret."
              : "Slack App token must start with xapp-. Enable Socket Mode and create an app-level token with connections:write, not a Signing Secret or Verification Token.",
        },
      ];
    },
  );
}

/**
 * EN: Builds the minimal Slack app manifest required by OysterWorkflow messaging.
 * 中文: 构建 OysterWorkflow 消息连接所需的最小 Slack App Manifest。
 * @returns formatted JSON ready to paste into Slack's app manifest editor.
 */
export function buildProductSlackAppManifest(): string {
  return `${JSON.stringify(
    {
      display_information: {
        name: "OysterWorkflow",
        description:
          "Connect Slack messages to your OysterWorkflow AI workers.",
        background_color: "#0f766e",
      },
      features: {
        bot_user: {
          display_name: "OysterWorkflow",
          always_online: true,
        },
        app_home: {
          home_tab_enabled: false,
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
      },
      oauth_config: {
        scopes: {
          bot: [
            "app_mentions:read",
            "channels:history",
            "channels:read",
            "chat:write",
            "files:read",
            "files:write",
            "groups:history",
            "groups:read",
            "im:history",
            "im:read",
            "im:write",
            "users:read",
          ],
        },
      },
      settings: {
        event_subscriptions: {
          bot_events: [
            "app_mention",
            "message.channels",
            "message.groups",
            "message.im",
          ],
        },
        interactivity: {
          is_enabled: true,
        },
        org_deploy_enabled: false,
        socket_mode_enabled: true,
        token_rotation_enabled: false,
      },
    },
    null,
    2,
  )}\n`;
}

function normalizeChannelPlatform(
  platform: ProductWorkerChannelPlatform | string,
): ProductWorkerChannelPlatform {
  if (
    platform === "telegram" ||
    platform === "slack" ||
    platform === "weixin" ||
    platform === "whatsapp" ||
    platform === "wecom"
  ) {
    return platform;
  }
  return "none";
}

function platformFromLegacyChannel(
  legacyCommandChannel?: string | null,
): ProductWorkerChannelPlatform {
  const normalized = legacyCommandChannel?.trim().toLowerCase() ?? "";
  if (normalized.includes("slack")) {
    return "slack";
  }
  if (normalized.includes("telegram")) {
    return "telegram";
  }
  if (normalized.includes("whatsapp")) {
    return "whatsapp";
  }
  if (normalized.includes("wecom") || normalized.includes("企业微信")) {
    return "wecom";
  }
  if (
    normalized.includes("wechat") ||
    normalized.includes("weixin") ||
    normalized.includes("微信")
  ) {
    return "weixin";
  }
  return "none";
}

function readCredential(
  credentials: Record<string, string>,
  key: string,
): string {
  return credentials[key]?.trim() ?? "";
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
