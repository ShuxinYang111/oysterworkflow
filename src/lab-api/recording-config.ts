import {
  DEFAULT_RECORDING_ENABLE_AUDIO,
  DEFAULT_RECORDING_OCR_LANGUAGE_PRIORITY,
  LAB_SCREENPIPE_LANGUAGES,
  type LabScreenpipeLanguage,
} from "./contracts.js";

/**
 * EN: Normalizes the requested OCR language priority and falls back to the project default when empty or invalid.
 * @param input requested OCR language priority from the UI, tests, or persisted session data.
 * @returns deduplicated language list in priority order.
 */
export function normalizeOcrLanguagePriority(
  input: unknown,
): LabScreenpipeLanguage[] {
  const candidates = Array.isArray(input)
    ? input
    : DEFAULT_RECORDING_OCR_LANGUAGE_PRIORITY;
  const languages = candidates.filter(
    (item, index, array): item is LabScreenpipeLanguage =>
      isLabScreenpipeLanguage(item) && array.indexOf(item) === index,
  );
  return languages.length > 0
    ? [...languages]
    : [...DEFAULT_RECORDING_OCR_LANGUAGE_PRIORITY];
}

/**
 * EN: Normalizes the requested audio capture flag and falls back to the project default when omitted.
 * @param input requested recorder audio setting from the UI, tests, or persisted session data.
 * @returns whether managed recording should capture system audio.
 */
export function normalizeEnableAudio(input: unknown): boolean {
  return typeof input === "boolean" ? input : DEFAULT_RECORDING_ENABLE_AUDIO;
}

function isLabScreenpipeLanguage(
  value: unknown,
): value is LabScreenpipeLanguage {
  return (
    typeof value === "string" &&
    (LAB_SCREENPIPE_LANGUAGES as readonly string[]).includes(value)
  );
}
