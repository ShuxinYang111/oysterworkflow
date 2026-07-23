import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLabService, type LabService } from "../src/lab-api/service.js";
import { resolveLabLlmCredentials } from "../src/lab-api/llm-config.js";
import {
  buildLlmModelsEndpoint,
  discoverLlmModels,
} from "../src/lab-api/llm-models.js";
import { resolveRuntimeConfig } from "../src/runtime/config.js";
import { createRuntimeHttpApp } from "../src/runtime/server.js";

describe("LLM model discovery", () => {
  const tempRoots: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    delete process.env.TEST_DISCOVERY_API_KEY;
    await Promise.all([
      ...tempRoots.splice(0).map((path) => rm(path, { recursive: true })),
      ...servers.splice(0).map(
        (server) =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) =>
              error ? rejectClose(error) : resolveClose(),
            );
          }),
      ),
    ]);
  });

  it("builds the standard models endpoint from provider base URLs", () => {
    expect(buildLlmModelsEndpoint("https://api.example.com/v1")).toBe(
      "https://api.example.com/v1/models",
    );
    expect(buildLlmModelsEndpoint("http://127.0.0.1:18080/v1/models/")).toBe(
      "http://127.0.0.1:18080/v1/models",
    );
    expect(() => buildLlmModelsEndpoint("file:///tmp/models")).toThrow(
      "HTTP or HTTPS",
    );
  });

  it("loads, trims, and de-duplicates OpenAI-compatible model ids with bearer auth", async () => {
    let receivedEndpoint = "";
    let receivedAuthorization: string | null = null;
    const result = await discoverLlmModels(
      {
        baseUrl: "https://gateway.example.com/v1/",
        apiKey: "secret-key",
      },
      {
        fetchFn: async (input, init) => {
          receivedEndpoint = String(input);
          receivedAuthorization = new Headers(init?.headers).get(
            "authorization",
          );
          return new Response(
            JSON.stringify({
              object: "list",
              data: [
                { id: " gpt-5.5 " },
                { id: "gpt-5.4" },
                { id: "gpt-5.5" },
                { id: "" },
                { name: "missing-id" },
              ],
            }),
            { status: 200 },
          );
        },
      },
    );

    expect(receivedEndpoint).toBe("https://gateway.example.com/v1/models");
    expect(receivedAuthorization).toBe("Bearer secret-key");
    expect(result).toEqual({
      endpoint: "https://gateway.example.com/v1/models",
      models: ["gpt-5.5", "gpt-5.4"],
    });
  });

  it("returns an empty model list when the provider data array is empty", async () => {
    const result = await discoverLlmModels(
      { baseUrl: "http://127.0.0.1:18080/v1", apiKey: null },
      {
        fetchFn: async (_input, init) => {
          expect(new Headers(init?.headers).has("authorization")).toBe(false);
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        },
      },
    );

    expect(result.models).toEqual([]);
  });

  it("surfaces concise upstream and malformed-response errors", async () => {
    await expect(
      discoverLlmModels(
        { baseUrl: "https://gateway.example.com/v1", apiKey: null },
        {
          fetchFn: async () =>
            new Response(
              JSON.stringify({ error: { message: "Invalid API key" } }),
              { status: 401 },
            ),
        },
      ),
    ).rejects.toThrow("HTTP 401: Invalid API key");

    await expect(
      discoverLlmModels(
        { baseUrl: "https://gateway.example.com/v1", apiKey: null },
        {
          fetchFn: async () =>
            new Response(JSON.stringify({ models: [] }), { status: 200 }),
        },
      ),
    ).rejects.toThrow("data array");
  });

  it("aborts a model list request when the discovery timeout expires", async () => {
    await expect(
      discoverLlmModels(
        { baseUrl: "https://gateway.example.com/v1", apiKey: null },
        {
          timeoutMs: 5,
          fetchFn: async (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new Error("aborted")),
              );
            }),
        },
      ),
    ).rejects.toThrow("timed out after 5 ms");
  });

  it("resolves explicit, same-origin stored, environment, and disabled authentication", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "llm-models-test-"));
    tempRoots.push(tempRoot);
    const configPath = join(tempRoot, "llm.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        baseUrl: "https://gateway.example.com/v1",
        model: "gpt-5.5",
        apiKey: "stored-secret",
      }),
      "utf8",
    );

    await expect(
      resolveLabLlmCredentials(
        {
          baseUrl: "https://other.example.com/v1",
          authMode: "direct",
          apiKey: "submitted-secret",
        },
        configPath,
      ),
    ).resolves.toMatchObject({ apiKey: "submitted-secret" });
    await expect(
      resolveLabLlmCredentials(
        {
          baseUrl: "https://GATEWAY.example.com:443/compatible/v1",
          authMode: "direct",
          apiKey: "",
        },
        configPath,
      ),
    ).resolves.toMatchObject({ apiKey: "stored-secret" });
    await expect(
      resolveLabLlmCredentials(
        {
          baseUrl: "https://other.example.com/v1",
          authMode: "direct",
          apiKey: "",
        },
        configPath,
      ),
    ).rejects.toThrow("Base URL origin changed");

    process.env.TEST_DISCOVERY_API_KEY = "env-secret";
    await expect(
      resolveLabLlmCredentials(
        {
          baseUrl: "https://other.example.com/v1",
          authMode: "env",
          apiKeyEnv: "TEST_DISCOVERY_API_KEY",
        },
        configPath,
      ),
    ).resolves.toMatchObject({ apiKey: "env-secret" });
    await expect(
      resolveLabLlmCredentials(
        { baseUrl: "https://other.example.com/v1", authMode: "none" },
        configPath,
      ),
    ).resolves.toMatchObject({ apiKey: null });
  });

  it("rejects missing direct and environment credentials", async () => {
    const missingConfigPath = join(tmpdir(), "missing-llm-model-config.json");
    await expect(
      resolveLabLlmCredentials(
        {
          baseUrl: "https://gateway.example.com/v1",
          authMode: "direct",
          apiKey: null,
        },
        missingConfigPath,
      ),
    ).rejects.toThrow("API key is required");
    await expect(
      resolveLabLlmCredentials(
        {
          baseUrl: "https://gateway.example.com/v1",
          authMode: "env",
          apiKeyEnv: "TEST_DISCOVERY_API_KEY",
        },
        missingConfigPath,
      ),
    ).rejects.toThrow("does not contain an API key");
  });

  it("blocks cross-origin stored-key reuse before the model transport runs", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "llm-models-test-"));
    tempRoots.push(tempRoot);
    const configPath = join(tempRoot, "llm.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        baseUrl: "https://provider-a.example.com/v1",
        model: "gpt-5.5",
        apiKey: "provider-a-secret",
      }),
      "utf8",
    );
    const discoverLlmModelsFn = vi.fn(async () => ({
      endpoint: "https://provider-b.example.com/v1/models",
      models: [],
    }));
    const service = await createLabService({
      getLlmConfigPath: () => configPath,
      discoverLlmModelsFn,
    });

    await expect(
      service.listLlmModels({
        baseUrl: "https://provider-b.example.com/v1",
        authMode: "direct",
        apiKey: null,
      }),
    ).rejects.toThrow("Base URL origin changed");
    expect(discoverLlmModelsFn).not.toHaveBeenCalled();

    await expect(
      service.listLlmModels({
        baseUrl: "https://provider-b.example.com/v1",
        authMode: "none",
      }),
    ).resolves.toEqual({
      endpoint: "https://provider-b.example.com/v1/models",
      models: [],
    });
    expect(discoverLlmModelsFn).toHaveBeenLastCalledWith({
      baseUrl: "https://provider-b.example.com/v1",
      apiKey: null,
    });
  });

  it("exposes model discovery through the local Runtime API", async () => {
    const listLlmModels = vi.fn(async () => ({
      endpoint: "http://127.0.0.1:18080/v1/models",
      models: ["gpt-5.5", "gpt-5.4"],
    }));
    const app = createRuntimeHttpApp({
      service: { listLlmModels } as unknown as LabService,
      config: resolveRuntimeConfig({ mode: "test", apiPort: 0 }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );
    const address = server.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/llm/models`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: "http://127.0.0.1:18080/v1",
          authMode: "none",
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      endpoint: "http://127.0.0.1:18080/v1/models",
      models: ["gpt-5.5", "gpt-5.4"],
    });
    expect(listLlmModels).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:18080/v1",
      authMode: "none",
    });
  });
});
