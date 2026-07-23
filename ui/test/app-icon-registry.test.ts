import { describe, expect, it } from "vitest";
import {
  resolveWorkflowApp,
  resolveWorkflowApps,
} from "../src/app-icon-registry";

describe("app icon registry", () => {
  it("normalizes browser names without hiding more specific services", () => {
    expect(resolveWorkflowApp("Google Chrome").label).toBe("Chrome");
    expect(resolveWorkflowApp("Chrome").id).toBe("chrome");
    expect(
      resolveWorkflowApp([
        "Open Google Chrome",
        "Continue in the existing ChatGPT conversation",
      ]).label,
    ).toBe("ChatGPT");
  });

  it("recognizes Google document services from app names and URLs", () => {
    expect(resolveWorkflowApp("Google Docs").label).toBe("Google Docs");
    expect(resolveWorkflowApp("Google Doc").label).toBe("Google Docs");
    expect(
      resolveWorkflowApp("https://docs.google.com/document/d/abc").id,
    ).toBe("google-docs");
  });

  it("recognizes Microsoft OneDrive case materials", () => {
    const app = resolveWorkflowApp("OneDrive / Clients.docx");

    expect(app.id).toBe("onedrive");
    expect(app.label).toBe("OneDrive");
  });

  it("uses generic fallbacks without defaulting unknown apps to Chrome", () => {
    const desktop = resolveWorkflowApp("Unknown Local Tool");
    const web = resolveWorkflowApp("https://example.internal/workflow");

    expect(desktop.id).toBe("desktop-app");
    expect(desktop.label).not.toBe("Chrome");
    expect(web.id).toBe("web-app");
    expect(web.label).not.toBe("Chrome");
  });

  it("extracts multiple service identities from workflow evidence", () => {
    const apps = resolveWorkflowApps([
      "Open Google Chrome and review a ChatGPT conversation",
      "Watch the embedded YouTube launch video on YC Launch",
      "Write notes in Google Docs",
    ]).map((app) => app.label);

    expect(apps).toEqual([
      "ChatGPT",
      "YC Launch",
      "YouTube",
      "Google Docs",
      "Chrome",
    ]);
  });
});
