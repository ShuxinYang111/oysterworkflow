/**
 * EN: Parses pagination limit as a positive integer.
 * @param value raw limit value.
 * @returns positive integer or null.
 */
export function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.trunc(value);
}

/**
 * EN: Parses total count as a non-negative number.
 * @param value raw total value.
 * @returns non-negative number or null.
 */
export function normalizeNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

/**
 * EN: Checks whether value is a non-empty string after trimming.
 * @param value candidate value.
 * @returns true when the value is a non-empty string.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * EN: Narrows unknown value into an object record.
 * @param value candidate value.
 * @returns true when the value is a non-null object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * EN: Safely converts unknown value into object record.
 * @param value candidate value.
 * @returns object record or null.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/**
 * EN: Checks whether a field on an object is a non-null object.
 * @param obj input object.
 * @param key field name.
 * @returns true when field contains object.
 */
export function hasObject(obj: Record<string, unknown>, key: string): boolean {
  return isRecord(obj[key]);
}

/**
 * EN: Returns first non-empty string from candidate keys.
 * @param obj input object.
 * @param keys candidate field names.
 * @returns string or null.
 */
export function pickNullableString(
  obj: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * EN: Returns first finite number from candidate keys.
 * @param obj input object.
 * @param keys candidate field names.
 * @returns number or null.
 */
export function pickNullableNumber(
  obj: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

/**
 * EN: Converts unknown errors into string messages.
 * @param error unknown error value.
 * @returns error message.
 */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
