import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const safeStorageMock = {
  decryptString: vi.fn((value: Buffer) => value.toString("utf8")),
  encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
  isEncryptionAvailable: vi.fn(() => true),
};
const tempRoots: string[] = [];

vi.mock("electron", () => ({
  safeStorage: safeStorageMock,
}));

describe("desktop Supabase authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      tempRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("retries session restoration after a transient initialization failure", async () => {
    const getSession = vi
      .fn()
      .mockResolvedValueOnce({
        data: { session: null },
        error: { message: "Keychain was temporarily unavailable." },
      })
      .mockResolvedValueOnce({
        data: { session: null },
        error: null,
      });
    const client = {
      auth: {
        getSession,
        onAuthStateChange: vi.fn(),
      },
    } as unknown as SupabaseClient;
    const { SupabaseDesktopAuthService } =
      await import("../desktop/supabase-auth.js");
    const service = new SupabaseDesktopAuthService({
      storagePath: "/unused/auth.json",
      openExternal: async () => undefined,
      client,
    });

    await expect(service.initialize()).rejects.toThrow(
      "Keychain was temporarily unavailable.",
    );
    await expect(service.initialize()).resolves.toMatchObject({
      status: "signed_out",
      user: null,
    });
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("recovers a truncated auth file and replaces it atomically on the next write", async () => {
    const root = await createTempRoot();
    const storagePath = join(root, "auth", "session.json");
    await mkdir(join(root, "auth"), { recursive: true });
    await writeFile(storagePath, '{"version":1,"values":', "utf8");
    const { EncryptedFileAuthStorage } =
      await import("../desktop/supabase-auth.js");
    const storage = new EncryptedFileAuthStorage(storagePath);

    await expect(storage.getItem("session")).resolves.toBeNull();
    await storage.setItem("session", "restored-session");

    expect(JSON.parse(await readFile(storagePath, "utf8"))).toEqual({
      version: 1,
      values: {
        session: Buffer.from("restored-session", "utf8").toString("base64"),
      },
    });
  });

  it("does not permanently cache a transient auth-file read failure", async () => {
    const root = await createTempRoot();
    const storagePath = join(root, "session.json");
    await mkdir(storagePath);
    const { EncryptedFileAuthStorage } =
      await import("../desktop/supabase-auth.js");
    const storage = new EncryptedFileAuthStorage(storagePath);

    await expect(storage.getItem("session")).rejects.toBeDefined();
    await rm(storagePath, { recursive: true, force: true });
    await writeFile(
      storagePath,
      `${JSON.stringify({
        version: 1,
        values: {
          session: Buffer.from("retry-session", "utf8").toString("base64"),
        },
      })}\n`,
      "utf8",
    );

    await expect(storage.getItem("session")).resolves.toBe("retry-session");
  });

  it("keeps synchronous snapshots non-blocking while session verification times out", async () => {
    vi.useFakeTimers();
    const session = createSession("snapshot-user", "snapshot-token");
    const client = {
      auth: {
        getSession: async () => ({ data: { session }, error: null }),
        getUser: () => new Promise<never>(() => undefined),
        onAuthStateChange: vi.fn(),
      },
    } as unknown as SupabaseClient;
    const { SupabaseDesktopAuthService } =
      await import("../desktop/supabase-auth.js");
    const service = new SupabaseDesktopAuthService({
      storagePath: "/unused/auth.json",
      openExternal: async () => undefined,
      client,
      authOperationTimeoutMs: 25,
    });
    const initialization = service.initialize();
    const assertion = expect(initialization).rejects.toThrow(
      "Timed out while verifying the saved session",
    );

    expect(service.getStateSnapshot().status).toBe("loading");
    expect(service.getAccessTokenSnapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(service.getAccessTokenSnapshot()).toBeNull();
  });

  it("fences a timed-out sign-in from late state changes and duplicate retries", async () => {
    vi.useFakeTimers();
    const lateSession = createSession("late-user", "late-token");
    const retrySession = createSession("retry-user", "retry-token");
    const firstSignIn = deferred<{
      data: { session: Session };
      error: null;
    }>();
    let authListener:
      ((event: string, session: Session | null) => void) | undefined;
    const signInWithPassword = vi
      .fn()
      .mockImplementationOnce(() => firstSignIn.promise)
      .mockResolvedValueOnce({
        data: { session: retrySession },
        error: null,
      });
    const client = {
      auth: {
        getSession: async () => ({ data: { session: null }, error: null }),
        signInWithPassword,
        onAuthStateChange: vi.fn((listener) => {
          authListener = listener;
          return { data: { subscription: { unsubscribe: vi.fn() } } };
        }),
      },
    } as unknown as SupabaseClient;
    const { SupabaseDesktopAuthService } =
      await import("../desktop/supabase-auth.js");
    const service = new SupabaseDesktopAuthService({
      storagePath: "/unused/auth.json",
      openExternal: async () => undefined,
      client,
      authOperationTimeoutMs: 25,
    });
    await service.initialize();

    const signIn = service.signIn({
      email: "late@example.com",
      password: "password",
    });
    const assertion = expect(signIn).rejects.toThrow(
      "Timed out while signing in",
    );
    await vi.advanceTimersByTimeAsync(25);
    await assertion;

    authListener?.("SIGNED_IN", lateSession);
    expect(service.getStateSnapshot().status).toBe("signed_out");
    expect(service.getAccessTokenSnapshot()).toBeNull();
    await expect(
      service.signIn({ email: "retry@example.com", password: "password" }),
    ).rejects.toThrow("previous authentication request is still finishing");
    expect(signInWithPassword).toHaveBeenCalledTimes(1);

    firstSignIn.resolve({ data: { session: lateSession }, error: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(service.getStateSnapshot().status).toBe("signed_out");

    await expect(
      service.signIn({ email: "retry@example.com", password: "password" }),
    ).resolves.toMatchObject({ state: { status: "signed_in" } });
    expect(service.getAccessTokenSnapshot()).toBe("retry-token");
  });
});

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oyster-desktop-auth-"));
  tempRoots.push(root);
  return root;
}

function createSession(userId: string, accessToken: string): Session {
  return {
    access_token: accessToken,
    refresh_token: "refresh-token",
    expires_in: 3_600,
    token_type: "bearer",
    user: {
      id: userId,
      email: `${userId}@example.com`,
      app_metadata: {},
      user_metadata: {},
      aud: "authenticated",
      created_at: "2026-07-17T00:00:00.000Z",
    },
  } as Session;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
