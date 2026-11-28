import { constants } from "node:os";
import { createRequire } from "node:module";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";

type Exchange = (target: string, stage: string) => void;
type NativeFfi = {
  load(file: null): { func(signature: string): (...args: (string | number)[]) => number };
  errno(): number;
};

export const ATOMIC_EXCHANGE_UNAVAILABLE = "headless_atomic_exchange_unavailable";

export function atomicExchangeUnavailable() {
  return new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "This filesystem cannot atomically exchange an existing note.",
    { reasonCode: ATOMIC_EXCHANGE_UNAVAILABLE });
}

let exchange: Exchange | null | undefined;

/** Reuse the optional FFI runtime already shipped for native asset ingestion.
 * Only true name exchanges qualify. ReplaceFileW with backup was observable
 * as missing by a concurrent reader on NTFS, even when the call succeeded. */
export function nativeFilesystemExchange(): Exchange | undefined {
  if (exchange !== undefined) return exchange ?? undefined;
  exchange = null;
  if (process.platform !== "linux" && process.platform !== "darwin") return undefined;
  try {
    const koffi: NativeFfi = createRequire(import.meta.url)("koffi");
    const libc = koffi.load(null);
    const linux = process.platform === "linux";
    const call = linux
      ? libc.func("int renameat2(int olddirfd, str oldpath, int newdirfd, str newpath, unsigned int flags)")
      : libc.func("int renamex_np(str from, str to, unsigned int flags)");
    exchange = (target, stage) => {
      // AT_FDCWD = -100 (Linux). RENAME_EXCHANGE and RENAME_SWAP are both bit 1.
      const result = linux ? call(-100, target, -100, stage, 2) : call(target, stage, 2);
      if (result === 0) return;
      const error = koffi.errno();
      const errno = constants.errno;
      if (error === errno.ENOENT) throw new McpError(BaseErrorCode.CONFLICT, "The exchange target no longer exists.");
      if ([errno.ENOSYS, errno.ENOTSUP, errno.EOPNOTSUPP, errno.EINVAL, errno.EXDEV].includes(error)) {
        throw atomicExchangeUnavailable();
      }
      throw new Error(`Native filesystem exchange failed (errno ${error}).`);
    };
  } catch {
    // Missing addon or missing libc symbol. Admission fails closed by default.
  }
  return exchange ?? undefined;
}
