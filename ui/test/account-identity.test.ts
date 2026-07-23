import { describe, expect, it } from "vitest";
import { resolveAccountDisplayIdentity } from "../src/account-identity";
import type { ProductAccount } from "../../src/product/contracts.js";

const staleDemoAccount: ProductAccount = {
  id: "account-alex",
  name: "Alex Yang",
  email: "alexyang@oysterworkflow.com",
  workspaceId: "workspace-demo",
  signedInLabel: "OysterWorkflow",
  cloudProvider: null,
  cloudUserId: null,
  setupCompleted: true,
  updatedAt: "2026-07-09T00:00:00.000Z",
};

describe("account display identity", () => {
  it("uses the authenticated Supabase identity before stale local demo data", () => {
    expect(
      resolveAccountDisplayIdentity(
        {
          id: "cloud-user",
          email: "shuxin.y.97@gmail.com",
          displayName: "Yang Shuxin",
          provider: "google",
          createdAt: "2026-07-09T00:00:00.000Z",
        },
        staleDemoAccount,
      ),
    ).toEqual({
      name: "Yang Shuxin",
      email: "shuxin.y.97@gmail.com",
      initials: "YS",
      source: "cloud",
    });
  });

  it("derives a non-demo name from the authenticated email", () => {
    expect(
      resolveAccountDisplayIdentity(
        {
          id: "cloud-user",
          email: "shuxin.y.97@gmail.com",
          displayName: null,
          provider: "google",
          createdAt: null,
        },
        staleDemoAccount,
      ),
    ).toMatchObject({
      name: "Shuxin Y 97",
      email: "shuxin.y.97@gmail.com",
      source: "cloud",
    });
  });

  it("renders a neutral loading identity instead of the Alex placeholder", () => {
    expect(resolveAccountDisplayIdentity(null, null)).toEqual({
      name: "OysterWorkflow",
      email: "",
      initials: "OW",
      source: "loading",
    });
  });
});
