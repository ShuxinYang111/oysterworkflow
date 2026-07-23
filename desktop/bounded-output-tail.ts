const DEFAULT_OUTPUT_TAIL_BYTES = 64 * 1024;

/**
 * EN: Retains only the final bytes from a long-running child process stream.
 * 中文: 只保留长时间运行子进程输出的末尾字节，防止日志无限增长。
 */
export class BoundedOutputTail {
  private readonly maximumBytes: number;
  private value = Buffer.alloc(0);

  /**
   * @param maximumBytes maximum UTF-8 byte tail retained in memory.
   */
  constructor(maximumBytes = DEFAULT_OUTPUT_TAIL_BYTES) {
    if (!Number.isInteger(maximumBytes) || maximumBytes <= 0) {
      throw new Error("Output tail size must be a positive integer.");
    }
    this.maximumBytes = maximumBytes;
  }

  /**
   * @param chunk next stdout or stderr chunk.
   * @returns void after the bounded tail is updated.
   */
  append(chunk: Buffer | string): void {
    const incoming = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk, "utf8");
    if (incoming.byteLength >= this.maximumBytes) {
      this.value = Buffer.from(
        incoming.subarray(incoming.byteLength - this.maximumBytes),
      );
      return;
    }
    const overflow = Math.max(
      0,
      this.value.byteLength + incoming.byteLength - this.maximumBytes,
    );
    this.value = Buffer.concat([this.value.subarray(overflow), incoming]);
  }

  /**
   * @returns retained output decoded as UTF-8 for JSON parsing and diagnostics.
   */
  text(): string {
    let readableStart = 0;
    while (
      readableStart < Math.min(3, this.value.byteLength) &&
      (this.value[readableStart]! & 0xc0) === 0x80
    ) {
      readableStart += 1;
    }
    return this.value.subarray(readableStart).toString("utf8");
  }

  /**
   * @returns number of retained bytes, always at or below the configured cap.
   */
  byteLength(): number {
    return this.value.byteLength;
  }
}
