const CREDENTIAL_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
]);

/**
 * EN: Returns whether a header carries provider credentials and must be origin-bound.
 * 中文: 判断一个 header 是否携带必须绑定来源的服务商凭据。
 * @param name HTTP header name.
 * @returns true for reserved credential headers.
 */
export function isLlmCredentialHeader(name: string): boolean {
  return CREDENTIAL_HEADER_NAMES.has(name.trim().toLowerCase());
}

/**
 * EN: Removes hidden credential headers while preserving ordinary provider headers.
 * 中文: 清除隐藏凭据 header，同时保留普通服务商 header。
 * @param headers stored extra headers.
 * @returns sanitized headers, or undefined when none remain.
 */
export function removeLlmCredentialHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const entries = Object.entries(headers).filter(
    ([name]) => !isLlmCredentialHeader(name),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * EN: Builds one canonical request header set for model discovery and model execution.
 * 中文: 为模型发现和模型执行构建同一套规范请求 header。
 * @param input optional API key, extra headers, and base headers.
 * @returns normalized Headers instance with explicit API key taking precedence.
 */
export function buildLlmRequestHeaders(input: {
  apiKey?: string | null;
  extraHeaders?: Record<string, string>;
  baseHeaders?: HeadersInit;
}): Headers {
  const headers = new Headers(input.baseHeaders);
  for (const [name, value] of Object.entries(input.extraHeaders ?? {})) {
    const normalizedName = name.trim();
    const normalizedValue = value.trim();
    if (normalizedName && normalizedValue) {
      headers.set(normalizedName, normalizedValue);
    }
  }
  const apiKey = input.apiKey?.trim();
  if (apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

/**
 * EN: Compares provider credential boundaries using normalized HTTP(S) origins.
 * 中文: 使用规范化 HTTP(S) origin 比较服务商凭据边界。
 * @param left first provider base URL.
 * @param right second provider base URL.
 * @returns whether both URLs share the same credential origin.
 */
export function shareLlmCredentialOrigin(left: string, right: string): boolean {
  return (
    normalizeLlmCredentialOrigin(left) === normalizeLlmCredentialOrigin(right)
  );
}

/**
 * EN: Normalizes one HTTP(S) provider URL to its credential origin.
 * 中文: 将 HTTP(S) 服务商 URL 规范化为凭据 origin。
 * @param baseUrl provider base URL.
 * @returns normalized URL origin.
 */
export function normalizeLlmCredentialOrigin(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new Error(
      "Base URL must be a valid absolute URL. / Base URL 必须是有效的绝对地址。",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      "Base URL must use HTTP or HTTPS. / Base URL 必须使用 HTTP 或 HTTPS。",
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      "Base URL must not contain embedded credentials. / Base URL 不能包含内嵌凭据。",
    );
  }
  return parsed.origin;
}
