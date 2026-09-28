import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ASSET_SOURCE_MAX_BYTES, type ImagePolicy, type ProcessedImage } from "./imageProcessing.js";

export type AssetJob = { kind: "convert"; bytes: Buffer; policy: ImagePolicy } |
  { kind: "inspect"; vaultRoot: string; assetFolder: string; filename: string; binding?: string } |
  { kind: "create"; vaultRoot: string; assetFolder: string; filename: string; binding: string; bytes: Buffer };
export class AssetWorkerError extends Error {
  constructor(readonly reason: string) { super("Asset processing did not complete."); }
}
let active = 0;
export const activeAssetWorkers = () => active;
const REASONS = new Set(["image_invalid", "image_limit", "image_policy_invalid", "svg_unsupported", "image_dependency_unavailable", "unsupported_platform", "native_backend_unavailable", "asset_path_invalid", "asset_parent_unsupported", "asset_parent_unavailable", "asset_binding_conflict", "asset_exists", "asset_absent", "asset_invalid_file", "asset_io_failed", "asset_read_limit", "asset_effect_unverified", "asset_job_invalid"]);

/** Bytes travel over private IPC, never through model arguments or command strings. */
export async function runAssetJob<T = ProcessedImage>(job: AssetJob, timeoutMs = 15000): Promise<T> {
  if (!job || !["convert", "inspect", "create"].includes(job.kind) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new AssetWorkerError("asset_job_invalid");
  if ("bytes" in job && (!Buffer.isBuffer(job.bytes) || job.bytes.length > ASSET_SOURCE_MAX_BYTES)) throw new AssetWorkerError("image_limit");
  if (active >= 2) throw new AssetWorkerError("asset_worker_busy");
  active++;
  return new Promise<T>((resolve, reject) => {
    const env: Record<string, string> = {};
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "PATH", "HOME"]) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    let child;
    try {
      child = fork(fileURLToPath(new URL("./assetWorker.js", import.meta.url)), [], {
        serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"],
        env, execArgv: ["--max-old-space-size=128"], windowsHide: true,
      });
    } catch {
      active--;
      reject(new AssetWorkerError("asset_worker_unavailable"));
      return;
    }
    let response: any, fault = false, expired = false;
    const timer = setTimeout(() => { expired = true; child.kill(); }, timeoutMs);
    child.once("message", value => { response = value; });
    child.once("error", () => { fault = true; child.kill(); });
    // close also follows a failed spawn, unlike exit. Keep the reservation until
    // the child is actually gone; a returned result is not lifecycle completion.
    child.once("close", code => {
      clearTimeout(timer);
      active--;
      if (expired) { reject(new AssetWorkerError("asset_worker_timeout")); return; }
      if (fault || code !== 0 || !response || typeof response.ok !== "boolean") {
        reject(new AssetWorkerError("asset_worker_unavailable")); return;
      }
      if (!response.ok) {
        reject(new AssetWorkerError(REASONS.has(response.reason) ? response.reason : "asset_job_invalid")); return;
      }
      resolve(response.result as T);
    });
    try { child.send(job, error => { if (error) { fault = true; child.kill(); } }); }
    catch { fault = true; child.kill(); }
  });
}
