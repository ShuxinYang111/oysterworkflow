import chromeIconUrl from "./assets/app-icons/iconify/chrome.svg";
import desktopAppIconUrl from "./assets/app-icons/iconify/desktop-app.svg";
import gmailIconUrl from "./assets/app-icons/iconify/gmail.svg";
import googleDocsIconUrl from "./assets/app-icons/iconify/google-docs.svg";
import googleDriveIconUrl from "./assets/app-icons/iconify/google-drive.svg";
import googleSheetsIconUrl from "./assets/app-icons/iconify/google-sheets.svg";
import linkedInIconUrl from "./assets/app-icons/iconify/linkedin.svg";
import microsoftExcelIconUrl from "./assets/app-icons/iconify/microsoft-excel.svg";
import microsoftOneDriveIconUrl from "./assets/app-icons/iconify/microsoft-onedrive.svg";
import microsoftOutlookIconUrl from "./assets/app-icons/iconify/microsoft-outlook.svg";
import microsoftWordIconUrl from "./assets/app-icons/iconify/microsoft-word.svg";
import openAiIconUrl from "./assets/app-icons/iconify/openai.svg";
import oysterIconUrl from "../../desktop/assets/app-icon.png";
import salesforceIconUrl from "./assets/app-icons/iconify/salesforce.svg";
import slackIconUrl from "./assets/app-icons/iconify/slack.svg";
import webAppIconUrl from "./assets/app-icons/iconify/web-app.svg";
import wechatIconUrl from "./assets/app-icons/iconify/wechat.svg";
import youtubeIconUrl from "./assets/app-icons/iconify/youtube.svg";

export type AppCategory =
  | "browser"
  | "chat"
  | "crm"
  | "desktop"
  | "docs"
  | "email"
  | "media"
  | "social"
  | "website";

export interface AppIdentity {
  id: string;
  label: string;
  icon: string;
  category: AppCategory;
  generic?: boolean;
}

interface AppMatcher {
  id: string;
  priority: number;
  displayOrder: number;
  patterns: RegExp[];
}

const APP_IDENTITIES: Record<string, AppIdentity> = {
  chatgpt: {
    id: "chatgpt",
    label: "ChatGPT",
    icon: openAiIconUrl,
    category: "chat",
  },
  "yc-launch": {
    id: "yc-launch",
    label: "YC Launch",
    icon: webAppIconUrl,
    category: "website",
    generic: true,
  },
  youtube: {
    id: "youtube",
    label: "YouTube",
    icon: youtubeIconUrl,
    category: "media",
  },
  "google-docs": {
    id: "google-docs",
    label: "Google Docs",
    icon: googleDocsIconUrl,
    category: "docs",
  },
  "google-drive": {
    id: "google-drive",
    label: "Google Drive",
    icon: googleDriveIconUrl,
    category: "docs",
  },
  "google-sheets": {
    id: "google-sheets",
    label: "Google Sheets",
    icon: googleSheetsIconUrl,
    category: "docs",
  },
  onedrive: {
    id: "onedrive",
    label: "OneDrive",
    icon: microsoftOneDriveIconUrl,
    category: "docs",
  },
  gmail: {
    id: "gmail",
    label: "Gmail",
    icon: gmailIconUrl,
    category: "email",
  },
  outlook: {
    id: "outlook",
    label: "Microsoft Outlook",
    icon: microsoftOutlookIconUrl,
    category: "email",
  },
  slack: {
    id: "slack",
    label: "Slack",
    icon: slackIconUrl,
    category: "chat",
  },
  salesforce: {
    id: "salesforce",
    label: "Salesforce",
    icon: salesforceIconUrl,
    category: "crm",
  },
  hubspot: {
    id: "hubspot",
    label: "HubSpot",
    icon: webAppIconUrl,
    category: "crm",
  },
  linkedin: {
    id: "linkedin",
    label: "LinkedIn",
    icon: linkedInIconUrl,
    category: "social",
  },
  wechat: {
    id: "wechat",
    label: "WeChat",
    icon: wechatIconUrl,
    category: "chat",
  },
  word: {
    id: "word",
    label: "Microsoft Word",
    icon: microsoftWordIconUrl,
    category: "docs",
  },
  excel: {
    id: "excel",
    label: "Microsoft Excel",
    icon: microsoftExcelIconUrl,
    category: "docs",
  },
  chrome: {
    id: "chrome",
    label: "Chrome",
    icon: chromeIconUrl,
    category: "browser",
  },
  oysterworkflow: {
    id: "oysterworkflow",
    label: "OysterWorkflow",
    icon: oysterIconUrl,
    category: "desktop",
  },
  autodl: {
    id: "autodl",
    label: "AutoDL",
    icon: webAppIconUrl,
    category: "website",
    generic: true,
  },
  "pirate-ship": {
    id: "pirate-ship",
    label: "Pirate Ship",
    icon: webAppIconUrl,
    category: "website",
    generic: true,
  },
  "ups-capital": {
    id: "ups-capital",
    label: "UPS Capital",
    icon: webAppIconUrl,
    category: "website",
    generic: true,
  },
  "web-app": {
    id: "web-app",
    label: "Web app",
    icon: webAppIconUrl,
    category: "website",
    generic: true,
  },
  "desktop-app": {
    id: "desktop-app",
    label: "Desktop app",
    icon: desktopAppIconUrl,
    category: "desktop",
    generic: true,
  },
};

const APP_MATCHERS: AppMatcher[] = [
  {
    id: "chatgpt",
    priority: 120,
    displayOrder: 10,
    patterns: [/\bchatgpt\b/i, /chat\.openai\.com/i, /\bopenai\b/i],
  },
  {
    id: "yc-launch",
    priority: 116,
    displayOrder: 20,
    patterns: [
      /\byc launch\b/i,
      /\bycombinator\.com\b/i,
      /\by combinator\b/i,
      /\bstartup directory\b/i,
      /\byc startup\b/i,
    ],
  },
  {
    id: "youtube",
    priority: 112,
    displayOrder: 30,
    patterns: [/\byoutube\b/i, /\byoutu\.be\b/i],
  },
  {
    id: "google-docs",
    priority: 110,
    displayOrder: 40,
    patterns: [/\bgoogle docs?\b/i, /\bgoogle doc\b/i, /docs\.google\.com/i],
  },
  {
    id: "google-drive",
    priority: 104,
    displayOrder: 50,
    patterns: [/\bgoogle drive\b/i, /drive\.google\.com/i],
  },
  {
    id: "google-sheets",
    priority: 104,
    displayOrder: 60,
    patterns: [
      /\bgoogle sheets?\b/i,
      /\bgoogle spreadsheet\b/i,
      /sheets\.google\.com/i,
    ],
  },
  {
    id: "onedrive",
    priority: 103,
    displayOrder: 65,
    patterns: [/\bonedrive\b/i, /\bone drive\b/i, /\b1drv\.ms\b/i],
  },
  {
    id: "gmail",
    priority: 102,
    displayOrder: 70,
    patterns: [/\bgmail\b/i, /mail\.google\.com/i],
  },
  {
    id: "outlook",
    priority: 102,
    displayOrder: 80,
    patterns: [
      /\boutlook\b/i,
      /\bmicrosoft outlook\b/i,
      /outlook\.office\.com/i,
    ],
  },
  {
    id: "slack",
    priority: 98,
    displayOrder: 90,
    patterns: [/\bslack\b/i],
  },
  {
    id: "salesforce",
    priority: 96,
    displayOrder: 100,
    patterns: [/\bsalesforce\b/i],
  },
  {
    id: "hubspot",
    priority: 96,
    displayOrder: 105,
    patterns: [/\bhubspot\b/i, /hubspot\.com/i],
  },
  {
    id: "linkedin",
    priority: 94,
    displayOrder: 110,
    patterns: [/\blinkedin\b/i],
  },
  {
    id: "wechat",
    priority: 94,
    displayOrder: 120,
    patterns: [/\bwechat\b/i, /\bweixin\b/i],
  },
  {
    id: "word",
    priority: 90,
    displayOrder: 130,
    patterns: [/\bmicrosoft word\b/i, /\bword document\b/i],
  },
  {
    id: "excel",
    priority: 90,
    displayOrder: 140,
    patterns: [/\bmicrosoft excel\b/i, /\bexcel\b/i],
  },
  {
    id: "autodl",
    priority: 88,
    displayOrder: 150,
    patterns: [/\bautodl\b/i, /autodl\.com/i],
  },
  {
    id: "pirate-ship",
    priority: 88,
    displayOrder: 160,
    patterns: [/\bpirate ship\b/i, /pirateship\.com/i],
  },
  {
    id: "ups-capital",
    priority: 88,
    displayOrder: 170,
    patterns: [/\bups capital\b/i, /\bupscapital\b/i],
  },
  {
    id: "chrome",
    priority: 10,
    displayOrder: 500,
    patterns: [/\bgoogle chrome\b/i, /\bchrome\b/i, /\bchromium\b/i],
  },
  {
    id: "oysterworkflow",
    priority: 10,
    displayOrder: 520,
    patterns: [/\boysterworkflow\b/i, /\boyster workflow\b/i],
  },
];

/**
 * EN: Resolves a raw app/site reference into the most specific known identity.
 * 中文: 将原始 app / 网站描述解析成最具体的可展示身份。
 * @param raw Raw app/site strings from workflow evidence or step text.
 * @returns matched app identity, or a generic web/desktop fallback.
 */
export function resolveWorkflowApp(raw: string | string[]): AppIdentity {
  const text = joinRaw(raw);
  const matches = findMatches(text);
  if (matches.length > 0) {
    return APP_IDENTITIES[matches[0].id];
  }
  return looksLikeWebReference(text)
    ? APP_IDENTITIES["web-app"]
    : APP_IDENTITIES["desktop-app"];
}

/**
 * EN: Resolves all app/service identities mentioned across workflow evidence.
 * 中文: 从 workflow 证据文本中提取所有可展示的 app / service。
 * @param chunks Evidence chunks from apps, windows, titles, bodies, hints, and context.
 * @returns unique app identities ordered for demo readability.
 */
export function resolveWorkflowApps(chunks: string[]): AppIdentity[] {
  const ids = new Set<string>();
  for (const chunk of chunks) {
    for (const match of findMatches(chunk)) {
      ids.add(match.id);
    }
  }

  return [...ids]
    .map((id) => APP_IDENTITIES[id])
    .filter((identity): identity is AppIdentity => Boolean(identity))
    .sort(
      (left, right) =>
        displayOrderFor(left.id) - displayOrderFor(right.id) ||
        left.label.localeCompare(right.label),
    );
}

function joinRaw(raw: string | string[]): string {
  return Array.isArray(raw) ? raw.filter(Boolean).join(" ") : raw;
}

function findMatches(raw: string): AppMatcher[] {
  const text = raw.trim();
  if (!text) {
    return [];
  }
  return APP_MATCHERS.filter((matcher) =>
    matcher.patterns.some((pattern) => pattern.test(text)),
  ).sort(
    (left, right) =>
      right.priority - left.priority || left.displayOrder - right.displayOrder,
  );
}

function displayOrderFor(id: string): number {
  return APP_MATCHERS.find((matcher) => matcher.id === id)?.displayOrder ?? 999;
}

function looksLikeWebReference(raw: string): boolean {
  return (
    /https?:\/\//i.test(raw) ||
    /\bwww\./i.test(raw) ||
    /\.[a-z]{2,}(?:\/|\b)/i.test(raw)
  );
}
