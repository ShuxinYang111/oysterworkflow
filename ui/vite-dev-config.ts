export const DEFAULT_LAB_UI_PORT = 5173;
export const DEFAULT_LAB_API_PORT = 3034;
export const LAB_API_PORT_ENV_NAME = "OYSTERWORKFLOW_API_PORT";

export interface LabUiDevServerConfig {
  port: number;
  apiPort: number;
  apiProxyTarget: string;
}

type LabUiEnvMap = Record<string, string | undefined>;

/**
 * EN: Resolves the lab UI dev-server ports, letting the API proxy follow the shared Runtime port env var.
 * @param env process environment values injected by the dev launcher.
 * @returns dev server port + proxy target for the local Runtime API.
 */
export function resolveLabUiDevServerConfig(
  env: LabUiEnvMap = process.env,
): LabUiDevServerConfig {
  const apiPort =
    parseLabPort(env[LAB_API_PORT_ENV_NAME]) ?? DEFAULT_LAB_API_PORT;
  return {
    port: DEFAULT_LAB_UI_PORT,
    apiPort,
    apiProxyTarget: `http://127.0.0.1:${apiPort}`,
  };
}

function parseLabPort(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}
