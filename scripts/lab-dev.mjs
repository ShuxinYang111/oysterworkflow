import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_PORT_ENV_NAME = "OYSTERWORKFLOW_API_PORT";
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";
const SHUTDOWN_TIMEOUT_MS = 5_000;
const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * EN: Starts the lab API + UI with a shared Runtime port so parallel dev sessions do not collide on localhost:3034.
 */
async function main() {
  const requestedApiPort = parsePort(process.env[API_PORT_ENV_NAME]);
  const apiPort = requestedApiPort ?? (await findFreePort());
  const sharedEnv = {
    ...process.env,
    [API_PORT_ENV_NAME]: String(apiPort),
  };

  process.stdout.write(
    `[lab:dev] using runtime api port ${apiPort} via ${API_PORT_ENV_NAME}\n`,
  );

  const children = [
    spawnLabeledProcess("api", ["run", "runtime:dev"], sharedEnv),
    spawnLabeledProcess("ui", ["run", "lab:ui"], sharedEnv),
  ];
  const exitPromises = children.map((child) => waitForExit(child));
  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    for (const child of children) {
      if (!child.killed) {
        child.kill(signal);
      }
    }

    setTimeout(() => {
      for (const child of children) {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }
    }, SHUTDOWN_TIMEOUT_MS).unref();
  };

  process.on("SIGINT", () => shutdown("SIGTERM"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const firstExit = await Promise.race(exitPromises);
  shutdown("SIGTERM");
  await Promise.allSettled(exitPromises);
  process.exitCode =
    typeof firstExit.code === "number"
      ? firstExit.code
      : firstExit.signal
        ? 1
        : 0;
}

function spawnLabeledProcess(label, args, env) {
  const child = spawn(NPM_COMMAND, args, {
    cwd: PROJECT_ROOT,
    env,
    stdio: ["inherit", "pipe", "pipe"],
  });

  pipeWithPrefix(child.stdout, label, process.stdout);
  pipeWithPrefix(child.stderr, label, process.stderr);
  child.once("error", (error) => {
    process.stderr.write(`[${label}] ${error.message}\n`);
  });

  return child;
}

function pipeWithPrefix(stream, label, output) {
  if (!stream) {
    return;
  }

  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      output.write(`[${label}] ${line}\n`);
    }
  });
  stream.on("end", () => {
    if (buffered.length > 0) {
      output.write(`[${label}] ${buffered}\n`);
    }
  });
}

function waitForExit(child) {
  return new Promise((resolveExit) => {
    child.once("exit", (code, signal) => {
      resolveExit({
        code,
        signal,
      });
    });
  });
}

async function findFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() =>
          rejectPort(new Error("Unable to resolve a free runtime API port.")),
        );
        return;
      }

      server.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

function parsePort(value) {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${API_PORT_ENV_NAME} must be a positive integer when provided, received: ${value}`,
    );
  }

  return parsed;
}

void main().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[lab:dev] failed to start: ${message}\n`);
  process.exitCode = 1;
});
