import { createWriteStream, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
// EN: Lightweight append-only NDJSON writer interface.
export interface NdjsonWriter {
  write: (value: unknown) => Promise<number>;
  close: () => Promise<void>;
  count: () => number;
}

/**
 * EN: Opens NDJSON writer and tracks line numbers for rawRef traceability.
 * @param filePath target NDJSON file path.
 * @returns writer object with write/close/count.
 */
export async function createNdjsonWriter(
  filePath: string,
): Promise<NdjsonWriter> {
  await mkdir(dirname(filePath), { recursive: true });

  const stream = createWriteStream(filePath, { encoding: "utf8", flags: "w" });
  let lines = 0;

  return {
    write: async (value: unknown) => {
      lines += 1;
      await writeLine(stream, `${JSON.stringify(value)}\n`);
      return lines;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        stream.end(() => resolve());
        stream.on("error", reject);
      });
    },
    count: () => lines,
  };
}

/**
 * EN: Writes one line and resolves when Node signals completion.
 * @param stream write stream.
 * @param line line text to write.
 * @returns resolves when write succeeds.
 */
function writeLine(stream: WriteStream, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(line, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
