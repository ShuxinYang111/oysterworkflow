import { describe, expect, it } from "vitest";
import {
  buildProductSlackAppManifest,
  productChannelBindingThreadId,
  validateProductWorkerChannelCredentials,
} from "../src/product/channels.js";

describe("product channel setup helpers", () => {
  it("rejects Slack credentials copied from the wrong developer fields", () => {
    expect(
      validateProductWorkerChannelCredentials("slack", {
        SLACK_BOT_TOKEN: "A012APPID",
        SLACK_APP_TOKEN: "verification-token",
      }),
    ).toEqual([
      expect.objectContaining({
        key: "SLACK_BOT_TOKEN",
        message: expect.stringContaining("xoxb-"),
      }),
      expect.objectContaining({
        key: "SLACK_APP_TOKEN",
        message: expect.stringContaining("xapp-"),
      }),
    ]);
  });

  it("builds a Socket Mode manifest with bidirectional message access", () => {
    const manifest = JSON.parse(buildProductSlackAppManifest()) as {
      features: { app_home: { messages_tab_enabled: boolean } };
      oauth_config: { scopes: { bot: string[] } };
      settings: {
        socket_mode_enabled: boolean;
        event_subscriptions: { bot_events: string[] };
      };
    };

    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.features.app_home.messages_tab_enabled).toBe(true);
    expect(manifest.oauth_config.scopes.bot).toEqual(
      expect.arrayContaining([
        "chat:write",
        "app_mentions:read",
        "channels:history",
        "groups:history",
        "im:history",
      ]),
    );
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining([
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
      ]),
    );
  });

  it("binds direct messages at conversation scope but preserves group threads", () => {
    expect(
      productChannelBindingThreadId({
        conversationType: "dm",
        threadId: "1783743936.350619",
      }),
    ).toBeNull();
    expect(
      productChannelBindingThreadId({
        conversationType: "channel",
        threadId: "1783743936.350619",
      }),
    ).toBe("1783743936.350619");
  });
});
