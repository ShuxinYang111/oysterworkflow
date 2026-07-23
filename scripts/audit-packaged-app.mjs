#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as asar from "@electron/asar";

const DISALLOWED_ENTRY_PATTERNS = [
  {
    label: "dependency test directories",
    regex: /\/node_modules\/.*\/(?:__tests__|tests?|test-fixtures)(?:\/|$)/,
  },
  {
    label: "dependency examples or benchmarks",
    regex:
      /\/node_modules\/.*\/(?:example|examples|benchmark|benchmarks|docs?|website)(?:\/|$)/,
  },
  {
    label: "dependency test files",
    regex: /\/node_modules\/.*\/[^/]+\.(?:test|spec)\.[^/]+$/,
  },
  {
    label: "dependency root test.js files",
    regex: /\/node_modules\/.*\/test\.js$/,
  },
  {
    label: "dependency build or lint config files",
    regex: /\/node_modules\/.*\/(?:eslint|vitest|jest|rollup)\.config\.[^/]+$/,
  },
  {
    label: "dependency TypeScript config files",
    regex: /\/node_modules\/.*\/tsconfig[^/]*\.json$/,
  },
  {
    label: "dependency nyc config files",
    regex: /\/node_modules\/.*\/\.nycrc$/,
  },
  {
    label: "package-specific source trees that should ship as compiled JS",
    regex: /\/node_modules\/zod\/src(?:\/|$)/,
  },
];

const REQUIRED_HELPER_RESOURCES = {
  darwin: [
    {
      relativePath: path.join("bin", "oysterworkflow-screenpipe"),
      executable: true,
    },
    {
      relativePath: path.join("bin", "screenpipe-bundle.json"),
      json: true,
    },
    {
      relativePath: path.join("bin", "oysterworkflow-hermes"),
      executable: true,
    },
    {
      relativePath: path.join("bin", "hermes-bundle.json"),
      json: true,
    },
    {
      relativePath: path.join("bin", "oysterworkflow-browseract"),
      executable: true,
    },
    {
      relativePath: path.join("bin", "browseract-bundle.json"),
      json: true,
    },
    {
      relativePath: path.join("bin", "oysterworkflow-uv"),
      executable: true,
    },
    {
      relativePath: path.join("bin", "node"),
      executable: true,
    },
    {
      relativePath: path.join("bin", "runtime-tools-bundle.json"),
      json: true,
    },
  ],
  win32: [
    {
      relativePath: path.join("bin", "oysterworkflow-screenpipe.exe"),
    },
    {
      relativePath: path.join("bin", "screenpipe-bundle.json"),
      json: true,
    },
    {
      relativePath: path.join("bin", "oysterworkflow-hermes.exe"),
    },
    {
      relativePath: path.join("bin", "hermes-bundle.json"),
      json: true,
    },
    {
      relativePath: path.join("bin", "oysterworkflow-browseract.cmd"),
    },
    {
      relativePath: path.join("bin", "browseract-bundle.json"),
      json: true,
    },
  ],
};

/**
 * EN: Electron Builder hook that audits the packaged app payload and fails the
 * build when obviously non-runtime dependency sources still leaked into app.asar.
 * @param context Electron Builder afterPack context.
 * @returns when the audit completes successfully.
 */
export default async function afterPack(context) {
  const appAsarPath = resolvePackagedAppAsarPath(context);
  auditPackagedApp(appAsarPath, {
    platform: context.electronPlatformName,
  });
}

async function main() {
  const cliTargets = process.argv.slice(2);
  const appAsarPaths =
    cliTargets.length > 0 ? cliTargets : await findDistAppAsarPaths();

  if (appAsarPaths.length === 0) {
    throw new Error(
      "No packaged app.asar files were found. Pass a path explicitly or build the desktop app first.",
    );
  }

  for (const appAsarPath of appAsarPaths) {
    auditPackagedApp(appAsarPath);
  }
}

/**
 * EN: Audits one packaged app for dependency-side test payload and required helper binaries.
 * @param appAsarPath absolute path to one packaged app.asar file.
 * @param options optional target platform override.
 * @returns when the archive passes the audit.
 */
function auditPackagedApp(appAsarPath, options = {}) {
  if (!existsSync(appAsarPath)) {
    throw new Error(`Packaged app.asar does not exist: ${appAsarPath}`);
  }

  const entries = asar.listPackage(appAsarPath);
  const findings = collectDisallowedEntries(entries);
  const resourceFindings = collectMissingHelperResources(appAsarPath, options);
  if (findings.length === 0 && resourceFindings.length === 0) {
    console.log(`[audit-packaged-app] OK ${appAsarPath}`);
    return;
  }

  const messages = [];
  if (findings.length > 0) {
    messages.push(
      `disallowed dependency payload:\n${formatDisallowedFindings(findings)}`,
    );
  }
  if (resourceFindings.length > 0) {
    messages.push(
      `missing or invalid required helper resources:\n${resourceFindings
        .map((finding) => `  - ${finding}`)
        .join("\n")}`,
    );
  }

  throw new Error(
    `Packaged app audit failed for ${appAsarPath}:\n${messages.join("\n")}`,
  );
}

/**
 * EN: Groups the first matching app.asar entries by violation category.
 * @param entries all file entries from app.asar.
 * @returns grouped findings.
 */
function collectDisallowedEntries(entries) {
  return DISALLOWED_ENTRY_PATTERNS.map((pattern) => ({
    label: pattern.label,
    entries: entries.filter((entry) => pattern.regex.test(entry)),
  })).filter((finding) => finding.entries.length > 0);
}

/**
 * EN: Checks Screenpipe and Hermes helper files that live beside app.asar.
 * @param appAsarPath absolute path to one packaged app.asar file.
 * @param options optional target platform override.
 * @returns missing or invalid resource descriptions.
 */
function collectMissingHelperResources(appAsarPath, options = {}) {
  const resourceRoot = path.dirname(appAsarPath);
  const platform = normalizePackagedPlatform(
    options.platform ?? inferPackagedPlatform(appAsarPath),
  );
  const resources =
    REQUIRED_HELPER_RESOURCES[platform] ?? REQUIRED_HELPER_RESOURCES.darwin;
  const findings = [];

  for (const resource of resources) {
    const resourcePath = path.join(resourceRoot, resource.relativePath);
    if (!existsSync(resourcePath)) {
      findings.push(`${resource.relativePath} is missing`);
      continue;
    }

    let stats;
    try {
      stats = statSync(resourcePath);
    } catch (error) {
      findings.push(
        `${resource.relativePath} cannot be inspected: ${errorMessage(error)}`,
      );
      continue;
    }

    if (!stats.isFile()) {
      findings.push(`${resource.relativePath} is not a file`);
      continue;
    }

    if (
      resource.executable &&
      platform !== "win32" &&
      (stats.mode & 0o111) === 0
    ) {
      findings.push(`${resource.relativePath} is not executable`);
    }

    if (resource.json) {
      try {
        JSON.parse(readFileSync(resourcePath, "utf8"));
      } catch (error) {
        findings.push(
          `${resource.relativePath} is not valid JSON: ${errorMessage(error)}`,
        );
      }
    }
  }

  findings.push(...collectHermesSourceSeedFindings(resourceRoot, platform));
  findings.push(...collectBrowserActRuntimeFindings(resourceRoot, platform));

  return findings;
}

function collectBrowserActRuntimeFindings(resourceRoot, platform) {
  if (platform !== "darwin") {
    return [];
  }
  const manifestPath = path.join(resourceRoot, "bin", "browseract-bundle.json");
  if (!existsSync(manifestPath)) {
    return [];
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return [];
  }
  const lockFiles = Array.isArray(manifest.lockFiles) ? manifest.lockFiles : [];
  const findings = [];
  for (const fileName of lockFiles) {
    if (typeof fileName !== "string" || !fileName.trim()) {
      findings.push(
        "bin/browseract-bundle.json has an invalid lockFiles entry",
      );
      continue;
    }
    const relativePath = path.join("config", "browseract-runtime", fileName);
    if (!existsSync(path.join(resourceRoot, relativePath))) {
      findings.push(`${relativePath} is missing`);
    }
  }
  return findings;
}

function collectHermesSourceSeedFindings(resourceRoot, platform) {
  const manifestPath = path.join(resourceRoot, "bin", "hermes-bundle.json");
  if (!existsSync(manifestPath)) {
    return [];
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return [];
  }

  const bundledSource = manifest?.bundledSource;
  const findings = [];
  if (!bundledSource || typeof bundledSource !== "object") {
    findings.push(...collectHermesBundledUvFindings(resourceRoot, manifest));
    if (platform === "darwin") {
      findings.push(
        ...collectHermesWhatsAppBridgeFindings(resourceRoot, manifest),
      );
    }
    return findings;
  }

  const directoryName = bundledSource.directoryName;
  const setupScript = bundledSource.setupScript;
  const digest = bundledSource.digest;
  if (typeof directoryName !== "string" || typeof setupScript !== "string") {
    findings.push(
      "bin/hermes-bundle.json has an invalid bundledSource declaration",
    );
    return findings;
  }

  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest)) {
    findings.push(
      "bin/hermes-bundle.json is missing a valid bundledSource digest",
    );
  } else {
    const launcherPath = path.join(
      resourceRoot,
      "bin",
      manifest.executableName === "hermes.exe"
        ? "oysterworkflow-hermes.exe"
        : "oysterworkflow-hermes",
    );
    if (
      existsSync(launcherPath) &&
      !readFileSync(launcherPath, "utf8").includes(digest)
    ) {
      findings.push(
        "bin/oysterworkflow-hermes does not enforce the bundledSource digest",
      );
    }
  }

  const relativeSetupPath = path.join("bin", directoryName, setupScript);
  const setupPath = path.join(resourceRoot, relativeSetupPath);
  if (!existsSync(setupPath)) {
    findings.push(`${relativeSetupPath} is missing`);
  } else {
    try {
      if (!statSync(setupPath).isFile()) {
        findings.push(`${relativeSetupPath} is not a file`);
      }
    } catch (error) {
      findings.push(
        `${relativeSetupPath} cannot be inspected: ${errorMessage(error)}`,
      );
    }
  }
  findings.push(...collectHermesBundledUvFindings(resourceRoot, manifest));
  if (platform === "darwin") {
    findings.push(
      ...collectHermesWhatsAppBridgeFindings(resourceRoot, manifest),
    );
  }
  return findings;
}

function collectHermesWhatsAppBridgeFindings(resourceRoot, manifest) {
  const bundledNode = manifest?.bundledNode;
  const bundledBridge = manifest?.bundledWhatsAppBridge;
  const findings = [];
  if (
    bundledNode?.relativePath !== "node" ||
    bundledNode?.strategy !== "electron-run-as-node"
  ) {
    findings.push(
      "bin/hermes-bundle.json is missing the Electron-backed Node declaration",
    );
  }
  if (
    !bundledBridge ||
    bundledBridge.dependencyStrategy !== "bundled-production-node-modules" ||
    typeof bundledBridge.relativePath !== "string"
  ) {
    findings.push(
      "bin/hermes-bundle.json is missing bundled WhatsApp bridge dependencies",
    );
    return findings;
  }

  const bridgeRoot = path.join(resourceRoot, "bin", bundledBridge.relativePath);
  for (const relativePath of [
    "bridge.js",
    "package.json",
    path.join("node_modules", ".package-lock.json"),
  ]) {
    const candidate = path.join(bridgeRoot, relativePath);
    if (!existsSync(candidate)) {
      findings.push(
        `${path.join("bin", bundledBridge.relativePath, relativePath)} is missing`,
      );
    }
  }
  return findings;
}

function collectHermesBundledUvFindings(resourceRoot, manifest) {
  const bundledUv = manifest?.bundledUv;
  if (!bundledUv || typeof bundledUv !== "object") {
    return [];
  }
  const relativePath = bundledUv.relativePath;
  if (typeof relativePath !== "string") {
    return ["bin/hermes-bundle.json has an invalid bundledUv declaration"];
  }
  const relativeUvPath = path.join("bin", relativePath);
  const uvPath = path.join(resourceRoot, relativeUvPath);
  if (!existsSync(uvPath)) {
    return [`${relativeUvPath} is missing`];
  }
  try {
    const stats = statSync(uvPath);
    if (!stats.isFile()) {
      return [`${relativeUvPath} is not a file`];
    }
    if ((stats.mode & 0o111) === 0) {
      return [`${relativeUvPath} is not executable`];
    }
  } catch (error) {
    return [`${relativeUvPath} cannot be inspected: ${errorMessage(error)}`];
  }
  return [];
}

function formatDisallowedFindings(findings) {
  return findings
    .map((finding) => {
      const sample = finding.entries
        .slice(0, 8)
        .map((entry) => `    - ${entry}`)
        .join("\n");
      const remainder =
        finding.entries.length > 8
          ? `\n    ... ${finding.entries.length - 8} more`
          : "";
      return `  ${finding.label} (${finding.entries.length})\n${sample}${remainder}`;
    })
    .join("\n");
}

function normalizePackagedPlatform(platform) {
  return platform === "win32" ? "win32" : "darwin";
}

function inferPackagedPlatform(appAsarPath) {
  const normalized = appAsarPath.split(path.sep).join("/");
  if (normalized.includes(".app/Contents/Resources/app.asar")) {
    return "darwin";
  }
  return process.platform;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * EN: Finds packaged app.asar files under the local dist directory.
 * @returns absolute app.asar paths under dist.
 */
async function findDistAppAsarPaths() {
  const projectRootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const distDir = path.join(projectRootDir, "dist");
  const appAsarPaths = [];

  for await (const entryPath of walkFiles(distDir)) {
    if (
      entryPath.endsWith(path.join("Contents", "Resources", "app.asar")) ||
      entryPath.endsWith(path.join("resources", "app.asar"))
    ) {
      appAsarPaths.push(entryPath);
    }
  }

  return appAsarPaths.sort();
}

function resolvePackagedAppAsarPath(context) {
  if (context.electronPlatformName === "darwin") {
    return path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      "Contents",
      "Resources",
      "app.asar",
    );
  }

  return path.join(context.appOutDir, "resources", "app.asar");
}

/**
 * EN: Recursively walks all files under one directory.
 * @param rootDir absolute directory path.
 * @returns async iterable file paths.
 */
async function* walkFiles(rootDir) {
  if (!existsSync(rootDir)) {
    return;
  }

  const entries = await readdir(rootDir, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(entryPath);
      continue;
    }
    if (entry.isFile()) {
      yield entryPath;
    }
  }
}

const currentModulePath = fileURLToPath(import.meta.url);
const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (entryPath && entryPath === currentModulePath) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[audit-packaged-app] ${message}`);
    process.exitCode = 1;
  });
}
