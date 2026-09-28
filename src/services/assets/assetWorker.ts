import { processImage, ImageProcessingError } from "./imageProcessing.js";
import { WindowsAssetFiles, AssetFileError } from "./windowsAssetFiles.js";

// Private process protocol, not an MCP endpoint. One request per process.
process.once("message", async (request: any) => {
  let result: unknown;
  try {
    if (!request || typeof request !== "object") throw new Error("invalid_job");
    if (request.kind === "convert") result = await processImage(request.bytes, request.policy);
    else if (request.kind === "inspect" || request.kind === "create") {
      const backend = new WindowsAssetFiles(request.vaultRoot, request.assetFolder);
      result = request.kind === "inspect"
        ? backend.inspect(request.filename, request.binding)
        : backend.create(request.filename, request.bytes, request.binding);
    } else throw new Error("invalid_job");
    process.send?.({ ok: true, result }, () => process.exit(0));
  } catch (error) {
    const reason = error instanceof ImageProcessingError || error instanceof AssetFileError
      ? error.reason : "asset_job_invalid";
    process.send?.({ ok: false, reason }, () => process.exit(0));
  }
});
