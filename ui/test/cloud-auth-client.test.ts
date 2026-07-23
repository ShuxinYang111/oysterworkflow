import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { exchangeBrowserCallback } from "../src/cloud-auth-client";

describe("browser OAuth callback exchange", () => {
  it("clears a rejected cached exchange so the same callback can be retried", async () => {
    window.history.replaceState({}, "", "/?code=retryable-code");
    const exchangeCodeForSession = vi
      .fn()
      .mockResolvedValueOnce({
        data: { session: null },
        error: { message: "temporary callback failure" },
      })
      .mockResolvedValueOnce({
        data: { session: {} },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { session: {} },
        error: null,
      });
    const client = {
      auth: { exchangeCodeForSession },
    } as unknown as SupabaseClient;

    await expect(exchangeBrowserCallback(client)).rejects.toThrow(
      "temporary callback failure",
    );
    await expect(exchangeBrowserCallback(client)).resolves.toBeUndefined();

    expect(exchangeCodeForSession).toHaveBeenCalledTimes(2);
    expect(new URL(window.location.href).searchParams.has("code")).toBe(false);

    window.history.replaceState({}, "", "/?code=next-code");
    await expect(exchangeBrowserCallback(client)).resolves.toBeUndefined();
    expect(exchangeCodeForSession).toHaveBeenCalledTimes(3);
    expect(exchangeCodeForSession).toHaveBeenLastCalledWith("next-code");
  });
});
