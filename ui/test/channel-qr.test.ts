import { describe, expect, it } from "vitest";
import { renderChannelQrDataUrl } from "../src/channel-qr";

describe("channel QR renderer", () => {
  it("renders WhatsApp and WeChat payloads as self-contained SVG data URLs", async () => {
    for (const payload of [
      "2@temporary-whatsapp-pairing-payload",
      "https://liteapp.weixin.qq.com/q/example?bot_type=3",
    ]) {
      const dataUrl = await renderChannelQrDataUrl(payload);
      expect(dataUrl).toMatch(/^data:image\/svg\+xml;charset=utf-8,/u);
      expect(decodeURIComponent(dataUrl.split(",", 2)[1])).toContain("<svg");
    }
  });
});
