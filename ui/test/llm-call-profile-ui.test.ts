import { describe, expect, it, vi } from "vitest";
import { LAB_LLM_CALL_PROFILE_KEYS } from "../../src/lab-api/api-contracts.js";
import {
  LLM_CALL_PROFILE_FIELDS,
  clearAdvancedLlmProfileOverrides,
} from "../src/settings-ui";

describe("LLM call profile UI registry", () => {
  it("provides bilingual labels for every unified call profile", () => {
    expect(LLM_CALL_PROFILE_FIELDS.map((field) => field.key)).toEqual(
      LAB_LLM_CALL_PROFILE_KEYS.filter((key) => key !== "planner-optimization"),
    );
    for (const field of LLM_CALL_PROFILE_FIELDS) {
      expect(field.label.en.trim()).not.toBe("");
      expect(field.label.zh.trim()).not.toBe("");
    }
  });

  it("clears every profile when advanced timeout or reasoning is disabled", () => {
    const update = vi.fn();
    clearAdvancedLlmProfileOverrides("reasoningEffort", update);
    clearAdvancedLlmProfileOverrides("responseReadTimeoutMs", update);

    expect(update).toHaveBeenCalledTimes(LAB_LLM_CALL_PROFILE_KEYS.length * 2);
    expect(
      update.mock.calls.slice(0, LAB_LLM_CALL_PROFILE_KEYS.length),
    ).toEqual(
      LAB_LLM_CALL_PROFILE_KEYS.map((key) => [key, "reasoningEffort", ""]),
    );
    expect(update.mock.calls.slice(LAB_LLM_CALL_PROFILE_KEYS.length)).toEqual(
      LAB_LLM_CALL_PROFILE_KEYS.map((key) => [
        key,
        "responseReadTimeoutMs",
        "",
      ]),
    );
  });
});
