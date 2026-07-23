import { describe, expect, it } from "vitest";
import type { ProductRunEvent } from "../../src/product/contracts.js";
import {
  productAgentConversationEventsForWorker,
  type ProductStateSnapshot,
} from "../src/product-runtime";

describe("product Agent conversation boundary", () => {
  it("rejects diagnostics even when legacy data labels them as an assistant response", () => {
    const events: ProductRunEvent[] = [
      {
        id: "event-user",
        runId: "run-1",
        workerId: "sales",
        source: "user",
        status: "User command",
        body: "Prepare the draft",
        createdAt: "2026-07-10T18:00:00.000Z",
      },
      {
        id: "event-cli",
        runId: "run-1",
        workerId: "sales",
        source: "hermes",
        status: "AI worker response",
        body: "✨ cua-driver-rs: update available\nRelease notes: https://github.com/trycua/cua",
        createdAt: "2026-07-10T18:01:00.000Z",
      },
      {
        id: "event-assistant",
        runId: "run-1",
        workerId: "sales",
        source: "hermes",
        status: "AI worker response",
        body: "The draft is ready for review and remains unsent.",
        createdAt: "2026-07-10T18:02:00.000Z",
      },
    ];
    const state = { runEvents: events } as ProductStateSnapshot;

    expect(
      productAgentConversationEventsForWorker(state, "sales").map(
        (event) => event.id,
      ),
    ).toEqual(["event-user", "event-assistant"]);
  });
});
