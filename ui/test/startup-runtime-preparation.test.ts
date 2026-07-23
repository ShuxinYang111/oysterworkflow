import { describe, expect, it, vi } from "vitest";
import type { StartupDependencyStatus } from "../src/startup-runtime-preparation";

const productRuntimeMock = vi.hoisted(() => ({
  fetchProductState: vi.fn(async () => ({ hermes: { available: true } })),
  prepareProductCapabilityProvider: vi.fn(),
  refreshProductHermes: vi.fn(),
}));
const settingsRuntimeMock = vi.hoisted(() => ({
  bootstrapRuntimeRecorder: vi.fn(),
}));

vi.mock("../src/product-runtime", () => productRuntimeMock);
vi.mock("../src/settings-runtime", () => settingsRuntimeMock);

describe("startup runtime preparation", () => {
  it("reports each parallel dependency as soon as it settles", async () => {
    const hermes = deferred<{
      hermes: { available: boolean; lastError: null };
    }>();
    const recorder = deferred<{ ready: boolean; summary: string }>();
    const browser = deferred<{
      provider: {
        installed: boolean;
        status: "ready" | "not_checked";
        detail: string;
      };
    }>();
    productRuntimeMock.refreshProductHermes.mockReturnValueOnce(hermes.promise);
    settingsRuntimeMock.bootstrapRuntimeRecorder.mockReturnValueOnce(
      recorder.promise,
    );
    productRuntimeMock.prepareProductCapabilityProvider.mockReturnValueOnce(
      browser.promise,
    );
    const changes: StartupDependencyStatus[] = [];
    const { prepareStartupRuntimeDependencies } =
      await import("../src/startup-runtime-preparation");
    const preparation = prepareStartupRuntimeDependencies({
      enableAudio: false,
      ocrLanguagePriority: ["chinese", "english"],
      onDependencyChange: (dependency) => changes.push(dependency),
    });

    browser.resolve({
      provider: {
        installed: true,
        status: "not_checked",
        detail: "Installed. Chrome has not been checked yet.",
      },
    });
    await Promise.resolve();
    expect(changes).toEqual([{ id: "browser", phase: "ready", detail: null }]);

    hermes.resolve({ hermes: { available: true, lastError: null } });
    recorder.resolve({ ready: true, summary: "Ready" });
    await preparation;
    expect(changes.map((item) => item.id).sort()).toEqual([
      "browser",
      "hermes",
      "screenpipe",
    ]);
  });

  it("marks an installed browser dependency ready without claiming Chrome was checked", async () => {
    productRuntimeMock.refreshProductHermes.mockResolvedValueOnce({
      hermes: { available: true, lastError: null },
    });
    settingsRuntimeMock.bootstrapRuntimeRecorder.mockResolvedValueOnce({
      ready: true,
      summary: "Ready",
    });
    productRuntimeMock.prepareProductCapabilityProvider.mockResolvedValueOnce({
      provider: {
        installed: true,
        status: "not_checked",
        detail: "Installed. Check Chrome before use.",
      },
    });
    const { prepareStartupRuntimeDependencies } =
      await import("../src/startup-runtime-preparation");

    const result = await prepareStartupRuntimeDependencies({
      enableAudio: false,
      ocrLanguagePriority: ["chinese", "english"],
    });

    expect(result.status.phase).toBe("ready");
    expect(result.status.dependencies).toContainEqual({
      id: "browser",
      phase: "ready",
      detail: null,
    });
  });

  it("keeps the browser dependency in attention when installation fails", async () => {
    productRuntimeMock.refreshProductHermes.mockResolvedValueOnce({
      hermes: { available: true, lastError: null },
    });
    settingsRuntimeMock.bootstrapRuntimeRecorder.mockResolvedValueOnce({
      ready: true,
      summary: "Ready",
    });
    productRuntimeMock.prepareProductCapabilityProvider.mockResolvedValueOnce({
      provider: {
        installed: false,
        status: "not_checked",
        detail: "Browser automation still needs attention.",
      },
    });
    const { prepareStartupRuntimeDependencies } =
      await import("../src/startup-runtime-preparation");

    const result = await prepareStartupRuntimeDependencies({
      enableAudio: false,
      ocrLanguagePriority: ["chinese", "english"],
    });

    expect(result.status.phase).toBe("attention");
    expect(result.status.dependencies).toContainEqual({
      id: "browser",
      phase: "attention",
      detail: "Browser automation still needs attention.",
    });
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
