import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const DEFAULT_PRIVATE_FILE_MODE = 0o600;

export interface AtomicJsonWriteOptions<T> {
  mode?: number;
  backup?: boolean;
  validate?: (value: unknown) => T;
}

export interface AtomicJsonReadOptions<T> {
  backupPath?: string;
  validate: (value: unknown) => T;
}

export interface AtomicTextWriteOptions {
  mode?: number;
  backup?: boolean;
  validateExisting?: (value: unknown) => unknown;
}

/**
 * EN: Writes validated JSON through a private temporary file and atomic rename.
 * 中文: 通过私有临时文件和原子重命名写入已校验 JSON。
 * @param filePath destination JSON path.
 * @param value serializable JSON value.
 * @param options validation, permissions, and backup controls.
 * @returns validated value written to disk.
 */
export async function writeJsonAtomic<T>(
  filePath: string,
  value: T,
  options: AtomicJsonWriteOptions<T> = {},
): Promise<T> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const parsed = JSON.parse(serialized) as unknown;
  const validated = options.validate ? options.validate(parsed) : value;
  const validatedSerialized = `${JSON.stringify(validated, null, 2)}\n`;
  await writeTextAtomic(filePath, validatedSerialized, {
    mode: options.mode,
    backup: options.backup,
    validateExisting: options.validate,
  });
  return validated;
}

/**
 * EN: Copies one JSON document only after parsing and validating it, then atomically activates it.
 * 中文: 解析并校验 JSON 后再原子复制并激活目标文件。
 * @param sourcePath source JSON file.
 * @param destinationPath destination JSON file.
 * @param options validation, permissions, and backup controls.
 * @returns validated copied value.
 */
export async function copyJsonAtomic<T>(
  sourcePath: string,
  destinationPath: string,
  options: AtomicJsonWriteOptions<T> & { validate: (value: unknown) => T },
): Promise<T> {
  const raw = await readFile(sourcePath, "utf8");
  const validated = options.validate(JSON.parse(raw) as unknown);
  await writeTextAtomic(
    destinationPath,
    `${JSON.stringify(validated, null, 2)}\n`,
    {
      mode: options.mode,
      backup: options.backup,
      validateExisting: options.validate,
    },
  );
  return validated;
}

/**
 * EN: Reads a validated JSON document and falls back to its last valid backup when needed.
 * 中文: 读取并校验 JSON；主文件损坏时回退到最后一个有效备份。
 * @param filePath primary JSON path.
 * @param options validator and optional backup path.
 * @returns validated value, null when neither file exists.
 */
export async function readJsonWithBackup<T>(
  filePath: string,
  options: AtomicJsonReadOptions<T>,
): Promise<T | null> {
  const backupPath = options.backupPath ?? `${filePath}.bak`;
  const primary = await tryReadValidatedJson(filePath, options.validate);
  if (primary.status === "valid") {
    return primary.value;
  }

  const backup = await tryReadValidatedJson(backupPath, options.validate);
  if (backup.status === "valid") {
    return backup.value;
  }
  if (primary.status === "missing" && backup.status === "missing") {
    return null;
  }

  const primaryDetail =
    primary.status === "invalid" ? primary.error.message : "file missing";
  const backupDetail =
    backup.status === "invalid" ? backup.error.message : "backup missing";
  throw new Error(
    `Unable to load valid JSON at ${filePath}. Primary: ${primaryDetail}. Backup: ${backupDetail}.`,
  );
}

/**
 * EN: Atomically replaces a text file through a private, fsynced temporary file.
 * 中文: 通过私有且已 fsync 的临时文件原子替换文本文件。
 * @param filePath destination text file.
 * @param contents complete replacement contents.
 * @param options permissions and backup controls.
 * @returns when the replacement and best-effort directory sync complete.
 */
export async function writeTextAtomic(
  filePath: string,
  contents: string,
  options: AtomicTextWriteOptions = {},
): Promise<void> {
  const directory = dirname(filePath);
  const mode = options.mode ?? DEFAULT_PRIVATE_FILE_MODE;
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const backupTemporaryPath = `${temporaryPath}.bak`;
  const backupPath = `${filePath}.bak`;
  await mkdir(directory, { recursive: true });

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let backupHandle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    if (options.backup !== false) {
      const backupContents = await readValidBackupContents(
        filePath,
        options.validateExisting,
      );
      if (backupContents !== null) {
        backupHandle = await open(backupTemporaryPath, "wx", mode);
        await backupHandle.writeFile(backupContents, "utf8");
        await backupHandle.sync();
        await backupHandle.close();
        backupHandle = null;
        await rename(backupTemporaryPath, backupPath);
      }
    }

    await rename(temporaryPath, filePath);
    await chmod(filePath, mode);
    await syncDirectoryBestEffort(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await backupHandle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    await rm(backupTemporaryPath, { force: true }).catch(() => undefined);
  }
}

async function readValidBackupContents<T>(
  filePath: string,
  validate: ((value: unknown) => T) | undefined,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (!validate) {
    return raw;
  }
  try {
    const validated = validate(JSON.parse(raw) as unknown);
    return `${JSON.stringify(validated, null, 2)}\n`;
  } catch {
    // EN/CN: Never replace the last valid backup with a corrupt primary file.
    return null;
  }
}

type JsonReadResult<T> =
  | { status: "valid"; value: T }
  | { status: "missing" }
  | { status: "invalid"; error: Error };

async function tryReadValidatedJson<T>(
  filePath: string,
  validate: (value: unknown) => T,
): Promise<JsonReadResult<T>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "invalid", error: toError(error) };
  }

  try {
    return {
      status: "valid",
      value: validate(JSON.parse(raw) as unknown),
    };
  } catch (error) {
    return { status: "invalid", error: toError(error) };
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // EN: Some platforms do not allow fsync on directory handles.
    // 中文: 部分平台不允许对目录句柄执行 fsync。
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
