/**
 * EN: Serializes JSON-like values with recursively sorted object keys.
 * 中文: 对对象键递归排序后序列化 JSON 风格值，确保比较与哈希稳定。
 * @param value value to serialize.
 * @returns deterministic JSON-like string.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value)) ?? "undefined";
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJsonValue(nested)]),
    );
  }
  return value;
}
