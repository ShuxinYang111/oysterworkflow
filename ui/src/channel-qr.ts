import QRCode from "qrcode";

const CHANNEL_QR_SIZE = 232;

/**
 * EN: Renders a channel pairing payload as a self-contained SVG data URL.
 * 中文: 将渠道配对 payload 渲染为自包含的 SVG data URL。
 * @param payload temporary channel pairing payload.
 * @returns SVG data URL that can be rendered without Canvas or a lazy chunk.
 */
export async function renderChannelQrDataUrl(payload: string): Promise<string> {
  const svg = await QRCode.toString(payload, {
    type: "svg",
    width: CHANNEL_QR_SIZE,
    margin: 2,
    errorCorrectionLevel: "M",
    color: { dark: "#10211f", light: "#ffffff" },
  });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
