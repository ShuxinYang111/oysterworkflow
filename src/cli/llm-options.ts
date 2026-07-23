import type { Command } from "commander";

export interface LlmCliOptionValues {
  config?: string;
  wireApi?: string;
  reasoningEffort?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * EN: Adds the common OpenAI-compatible LLM option group to one command.
 * @param command Commander command to extend.
 * @returns the same command for fluent chaining.
 */
export function withCommonLlmOptions<TCommand extends Command>(
  command: TCommand,
): TCommand {
  return command
    .option(
      "--config <path>",
      "LLM config JSON path (default: prefer <repo>/config/llm.local.json, fallback to <repo>/config/llm.config.json)",
    )
    .option(
      "--wire-api <mode>",
      "Wire API mode: responses | chat-completions (default from config)",
    )
    .option(
      "--reasoning-effort <level>",
      "Reasoning effort hint (default from config, e.g. xhigh)",
    )
    .option(
      "--model <name>",
      "OpenAI-compatible model override (default from config)",
    )
    .option(
      "--api-key <key>",
      "OpenAI-compatible API key override (default from config)",
    )
    .option(
      "--base-url <url>",
      "OpenAI-compatible API base URL override (default from config)",
    ) as TCommand;
}

/**
 * EN: Converts optional Commander values into the shared LLM override shape.
 * @param opts Commander option object.
 * @returns normalized optional LLM overrides.
 */
export function readCommonLlmOptions(
  opts: Record<string, unknown>,
): LlmCliOptionValues {
  return {
    config: optionString(opts.config),
    wireApi: optionString(opts.wireApi),
    reasoningEffort: optionString(opts.reasoningEffort),
    model: optionString(opts.model),
    apiKey: optionString(opts.apiKey),
    baseUrl: optionString(opts.baseUrl),
  };
}

function optionString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}
