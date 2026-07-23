#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_IDENTIFIER = "com.oysterworkflow.desktop";
const SCREENPIPE_HELPER_EXECUTABLE_NAME = "oysterworkflow-screenpipe";
const SCREENPIPE_IDENTIFIER = `${APP_IDENTIFIER}.screenpipe`;
const SCREENPIPE_HELPER_RESOURCE_DIRECTORY = "bin";
const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const APP_ENTITLEMENTS_PATH = path.join(
  PROJECT_ROOT,
  "desktop",
  "entitlements.mac.plist",
);
const SCREENPIPE_HELPER_ENTITLEMENTS_PATH = path.join(
  PROJECT_ROOT,
  "desktop",
  "entitlements.mac.helper.plist",
);

export default async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const appExecutablePath = path.join(
    appPath,
    "Contents",
    "MacOS",
    context.packager.appInfo.productFilename,
  );
  const helperPath = path.join(
    appPath,
    "Contents",
    "Resources",
    SCREENPIPE_HELPER_RESOURCE_DIRECTORY,
    SCREENPIPE_HELPER_EXECUTABLE_NAME,
  );
  const helperResourceDirectory = path.join(
    appPath,
    "Contents",
    "Resources",
    SCREENPIPE_HELPER_RESOURCE_DIRECTORY,
  );

  if (!existsSync(helperPath)) {
    return;
  }
  if (!existsSync(APP_ENTITLEMENTS_PATH)) {
    throw new Error(`Missing app entitlements file: ${APP_ENTITLEMENTS_PATH}`);
  }
  if (!existsSync(SCREENPIPE_HELPER_ENTITLEMENTS_PATH)) {
    throw new Error(
      `Missing screenpipe helper entitlements file: ${SCREENPIPE_HELPER_ENTITLEMENTS_PATH}`,
    );
  }

  const configuredIdentity =
    context.packager.platformSpecificBuildOptions.identity?.trim() ||
    process.env.CSC_NAME?.trim() ||
    null;
  const identity = resolveSigningIdentity(
    appExecutablePath,
    configuredIdentity,
  );
  const keychainFile = await resolveKeychainFile(context);
  const machOSidecars = await findMachOSidecars(helperResourceDirectory);

  signPath({
    target: helperPath,
    identity,
    keychainFile,
    extraArgs: [
      "--identifier",
      SCREENPIPE_IDENTIFIER,
      "--entitlements",
      SCREENPIPE_HELPER_ENTITLEMENTS_PATH,
      "--options",
      "runtime",
      // CN/EN: We intentionally do not preserve the old designated requirement
      // here because we are overriding the helper identifier. Preserving the
      // old requirement would keep the previous identifier in the requirement
      // and make the nested binary fail `codesign --verify --deep`.
      "--preserve-metadata=flags,runtime",
    ],
  });
  verifyPath({
    target: helperPath,
    deep: false,
  });

  for (const sidecarPath of machOSidecars) {
    if (sidecarPath === helperPath) {
      continue;
    }
    signPath({
      target: sidecarPath,
      identity,
      keychainFile,
      extraArgs: ["--options", "runtime"],
    });
    verifyPath({
      target: sidecarPath,
      deep: false,
    });
  }

  signPath({
    target: appPath,
    identity,
    keychainFile,
    extraArgs: [
      "--identifier",
      APP_IDENTIFIER,
      "--entitlements",
      APP_ENTITLEMENTS_PATH,
      "--options",
      "runtime",
      "--preserve-metadata=requirements,flags,runtime",
    ],
  });
  verifyPath({
    target: appPath,
    deep: true,
  });
}

async function findMachOSidecars(rootDirectory) {
  const result = [];
  await collectMachOSidecars(rootDirectory, result);
  return result.sort();
}

async function collectMachOSidecars(directory, result) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectMachOSidecars(entryPath, result);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (isMachOFile(entryPath)) {
      result.push(entryPath);
    }
  }
}

function isMissingPathError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isMachOFile(filePath) {
  const probe = spawnSync("/usr/bin/file", ["-b", filePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const details = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
  return probe.status === 0 && details.includes("Mach-O");
}

async function resolveKeychainFile(context) {
  if (!context.packager.codeSigningInfo) {
    return null;
  }

  const info = await context.packager.codeSigningInfo.value;
  return info?.keychainFile ?? null;
}

function resolveSigningIdentity(executablePath, configuredIdentity) {
  if (configuredIdentity) {
    return configuredIdentity;
  }

  const probe = spawnSync(
    "/usr/bin/codesign",
    ["-dv", "--verbose=4", executablePath],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const details = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;

  if (probe.status !== 0) {
    throw new Error(
      `Unable to inspect the current signing identity for ${executablePath}: ${details.trim()}`,
    );
  }

  if (details.includes("Signature=adhoc")) {
    return "-";
  }

  const authorityLine = details
    .split("\n")
    .find((line) => line.startsWith("Authority="));
  if (!authorityLine) {
    throw new Error(
      `Unable to infer a signing identity from ${executablePath}. Configure mac.identity or CSC_NAME explicitly.`,
    );
  }

  return authorityLine.slice("Authority=".length).trim();
}

function signPath(input) {
  const args = [
    "--force",
    "--sign",
    input.identity,
    resolveTimestampArgument(input.identity),
    ...input.extraArgs,
  ];

  if (input.keychainFile && input.identity !== "-") {
    args.push("--keychain", input.keychainFile);
  }

  args.push(input.target);
  execFileSync("/usr/bin/codesign", args, {
    stdio: "inherit",
  });
}

function resolveTimestampArgument(identity) {
  // CN/EN: Apple notarization requires a secure timestamp for real signing
  // identities, while ad-hoc signing cannot request one.
  return identity === "-" ? "--timestamp=none" : "--timestamp";
}

function verifyPath(input) {
  const args = [
    "--verify",
    "--strict",
    "--verbose=1",
    ...(input.deep ? ["--deep"] : []),
    input.target,
  ];
  execFileSync("/usr/bin/codesign", args, {
    stdio: "inherit",
  });
}
