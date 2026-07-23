import { readFile } from "node:fs/promises";
import { z } from "zod";
import { runOysterBrowserAction } from "../../product/browser-act.js";

const oysterBrowserArgsSchema = z.object({
  action: z.string().min(1),
  json: z.string().min(1).optional(),
  jsonFile: z.string().min(1).optional(),
});

export interface ParseOysterBrowserCliInput {
  action: string;
  json?: string;
  jsonFile?: string;
}

/**
 * EN: Parses oyster-browser command arguments.
 * 中文: 解析 oyster-browser 命令参数。
 * @param input raw CLI values.
 * @returns validated command input.
 */
export function parseOysterBrowserCliArgs(
  input: ParseOysterBrowserCliInput,
): ParseOysterBrowserCliInput {
  return oysterBrowserArgsSchema.parse(input);
}

/**
 * EN: Runs one BrowserAct-backed OysterWorkflow browser action.
 * 中文: 执行一个由 BrowserAct 支撑的 OysterWorkflow 浏览器动作。
 * @param input parsed CLI values.
 * @returns structured wrapper result.
 */
export async function runOysterBrowserCli(input: ParseOysterBrowserCliInput) {
  const payload = await readPayload(input);
  return runOysterBrowserAction(input.action, payload);
}

async function readPayload(
  input: ParseOysterBrowserCliInput,
): Promise<unknown> {
  if (input.json && input.jsonFile) {
    throw new Error("Use either --json or --json-file, not both.");
  }
  if (input.jsonFile) {
    return JSON.parse(await readFile(input.jsonFile, "utf8")) as unknown;
  }
  if (input.json) {
    return JSON.parse(input.json) as unknown;
  }
  return {};
}
