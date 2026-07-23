import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ScreenpipeClient,
  ScreenpipeHttpError,
} from "../src/screenpipe/client.js";

describe("screenpipe client health", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) =>
              error ? rejectClose(error) : resolveClose(),
            );
          }),
      ),
    );
  });

  it("returns degraded /health payloads even when Screenpipe responds with 503", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(503, {
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          status: "degraded",
          status_code: 503,
          frame_status: "not_started",
          audio_status: "disabled",
          message: "some systems are not healthy: vision",
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const client = new ScreenpipeClient(`http://127.0.0.1:${address.port}`);

    await expect(client.health()).resolves.toEqual({
      status: "degraded",
      status_code: 503,
      frame_status: "not_started",
      audio_status: "disabled",
      message: "some systems are not healthy: vision",
    });
  });

  it("still throws when /health returns a non-json server error", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(503, {
        "Content-Type": "text/plain",
      });
      res.end("server overloaded");
    });
    server.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const client = new ScreenpipeClient(`http://127.0.0.1:${address.port}`);

    await expect(client.health()).rejects.toBeInstanceOf(ScreenpipeHttpError);
  });

  it("sends a bearer token when Screenpipe API auth is configured", async () => {
    let authorization: string | undefined;
    const server = createServer((req, res) => {
      authorization = req.headers.authorization;
      res.writeHead(200, {
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          data: [],
          pagination: {
            limit: 1,
            offset: 0,
            total: 0,
          },
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const client = new ScreenpipeClient(`http://127.0.0.1:${address.port}`, {
      apiToken: "local-token",
    });

    await client.search({ content_type: "ocr", limit: 1 });

    expect(authorization).toBe("Bearer local-token");
  });

  it("deletes captured data for the requested recording window", async () => {
    let method: string | undefined;
    let body = "";
    const server = createServer((req, res) => {
      method = req.method;
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "application/json",
        });
        res.end(
          JSON.stringify({
            frames_deleted: 4,
            ocr_deleted: 4,
            audio_transcriptions_deleted: 0,
            audio_chunks_deleted: 0,
            video_chunks_deleted: 1,
            accessibility_deleted: 2,
            ui_events_deleted: 3,
            video_files_deleted: 1,
            audio_files_deleted: 0,
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const client = new ScreenpipeClient(`http://127.0.0.1:${address.port}`);
    const result = await client.deleteTimeRange({
      start: "2026-07-20T10:00:00.000Z",
      end: "2026-07-20T10:05:00.000Z",
    });

    expect(method).toBe("POST");
    expect(JSON.parse(body)).toEqual({
      start: "2026-07-20T10:00:00.000Z",
      end: "2026-07-20T10:05:00.000Z",
    });
    expect(result.frames_deleted).toBe(4);
    expect(result.ui_events_deleted).toBe(3);
  });
});
