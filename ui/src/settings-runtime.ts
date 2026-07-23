import type {
  LabLlmConfigUpdateInput,
  LabLlmModelsInput,
  LabSessionRecordingConfig,
  LlmConfigResponse,
  LlmModelsResponse,
  RecorderBootstrapResponse,
  RecorderPermissionsResponse,
} from "../../src/lab-api/api-contracts.js";
import { runtimeJsonRequest } from "./runtime-request";

/**
 * EN: Checks recorder permissions through the existing local Runtime.
 * 中文: 通过现有本地 Runtime 检查录制权限。
 * @param input optional force refresh flag.
 * @returns recorder permission snapshot.
 */
export async function checkRuntimeRecorderPermissions(
  input: { force?: boolean } = {},
): Promise<RecorderPermissionsResponse> {
  const suffix = input.force ? "?force=1" : "";
  return runtimeJsonRequest<RecorderPermissionsResponse>(
    `/api/recorder/permissions/check${suffix}`,
  );
}

/**
 * EN: Prepares the recorder using the selected recording config.
 * 中文: 使用当前录制配置准备录制器。
 * @param input OCR/audio recording config.
 * @returns recorder bootstrap status.
 */
export async function bootstrapRuntimeRecorder(
  input: Partial<LabSessionRecordingConfig>,
): Promise<RecorderBootstrapResponse> {
  return runtimeJsonRequest<RecorderBootstrapResponse>(
    "/api/recorder/bootstrap",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    {
      timeoutMs: 180_000,
      timeoutMessage:
        "Learning Mode preparation timed out. Try again from Applications. / Learning Mode 准备超时，请在应用页面重试。",
    },
  );
}

/**
 * EN: Reads the LLM config used by workflow generation.
 * 中文: 读取工作流生成使用的 LLM 配置。
 * @returns LLM config response.
 */
export async function fetchRuntimeLlmConfig(): Promise<LlmConfigResponse> {
  return runtimeJsonRequest<LlmConfigResponse>("/api/llm/config");
}

/**
 * EN: Updates the LLM config used by workflow generation.
 * 中文: 更新工作流生成使用的 LLM 配置。
 * @param input user-edited config.
 * @returns saved LLM config response.
 */
export async function updateRuntimeLlmConfig(
  input: LabLlmConfigUpdateInput,
): Promise<LlmConfigResponse> {
  return runtimeJsonRequest<LlmConfigResponse>("/api/llm/config", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * EN: Loads model identifiers exposed by the current OpenAI-compatible endpoint.
 * 中文: 加载当前 OpenAI-compatible 端点公开的模型标识符。
 * @param input current Base URL and authentication fields.
 * @returns available model identifiers and the resolved endpoint.
 */
export async function fetchRuntimeLlmModels(
  input: LabLlmModelsInput,
): Promise<LlmModelsResponse> {
  return runtimeJsonRequest<LlmModelsResponse>(
    "/api/llm/models",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    {
      timeoutMs: 90_000,
      timeoutMessage:
        "Model discovery timed out. Check the endpoint and try again. / 模型列表加载超时，请检查地址后重试。",
    },
  );
}
