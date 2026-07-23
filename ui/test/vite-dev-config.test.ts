import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAB_API_PORT,
  DEFAULT_LAB_UI_PORT,
  LAB_API_PORT_ENV_NAME,
  resolveLabUiDevServerConfig,
} from "../vite-dev-config";

describe("lab ui dev server config", () => {
  it("falls back to the default runtime api port when the shared env var is absent", () => {
    expect(resolveLabUiDevServerConfig({})).toEqual({
      port: DEFAULT_LAB_UI_PORT,
      apiPort: DEFAULT_LAB_API_PORT,
      apiProxyTarget: `http://127.0.0.1:${DEFAULT_LAB_API_PORT}`,
    });
  });

  it("uses the shared runtime api port env var for the Vite proxy target", () => {
    expect(
      resolveLabUiDevServerConfig({
        [LAB_API_PORT_ENV_NAME]: "43123",
      }),
    ).toEqual({
      port: DEFAULT_LAB_UI_PORT,
      apiPort: 43123,
      apiProxyTarget: "http://127.0.0.1:43123",
    });
  });
});
