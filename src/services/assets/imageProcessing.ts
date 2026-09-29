import { createRequire } from "node:module";
import { ASSET_MAX_BYTES, assetHash } from "./windowsAssetFiles.js";

export const ASSET_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
export const ASSET_MAX_PIXELS = 16 * 1024 * 1024;
export type ImagePolicy = { quality: number; preserveOriginal?: boolean; exceptionReason?: string };
export type ProcessedImage = {
  bytes: Buffer; format: string; width: number; height: number; pages: number;
  hasAlpha: boolean; sourceSha256: string; sha256: string; size: number;
  encoderVersion: string;
  exception: "none" | "vector_preserved" | "animation_preserved" | "original_requested";
};
export class ImageProcessingError extends Error {
  constructor(readonly reason: "image_invalid" | "image_limit" | "image_policy_invalid" | "svg_unsupported" | "image_dependency_unavailable") { super(reason); }
}
function reject(reason: ImageProcessingError["reason"]): never { throw new ImageProcessingError(reason); }

export function probeImageProcessingDependencies(
  load: NodeRequire = createRequire(import.meta.url),
): void {
  try {
    const sharp = load("sharp") as {
      (...args: unknown[]): unknown;
      versions?: { sharp?: unknown; vips?: unknown };
    };
    const saxes = load("saxes") as { SaxesParser?: unknown };
    if (
      typeof sharp !== "function" ||
      typeof sharp.versions?.sharp !== "string" ||
      typeof sharp.versions?.vips !== "string" ||
      typeof saxes?.SaxesParser !== "function"
    ) {
      reject("image_dependency_unavailable");
    }
  } catch (error) {
    if (error instanceof ImageProcessingError) throw error;
    reject("image_dependency_unavailable");
  }
}
const VECTOR_TAGS = new Set(["svg", "g", "defs", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "title", "desc", "use", "symbol", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern"]);

/** A deliberately restricted inert SVG subset; unsupported inputs are not rewritten. */
function verifySvg(bytes: Buffer): void {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || /<!DOCTYPE|<!ENTITY/iu.test(text)) reject("svg_unsupported");
  let SaxesParser: any;
  try { ({ SaxesParser } = createRequire(import.meta.url)("saxes")); }
  catch { reject("image_dependency_unavailable"); }
  let nodes = 0, depth = 0;
  try {
    const parser = new SaxesParser({ xmlns: false });
    parser.on("doctype", () => reject("svg_unsupported"));
    parser.on("processinginstruction", () => reject("svg_unsupported"));
    parser.on("error", () => reject("svg_unsupported"));
    parser.on("opentag", (tag: { name: string; attributes: Record<string, string> }) => {
      if (++nodes > 10000 || ++depth > 64 || !VECTOR_TAGS.has(tag.name) || (nodes === 1 && tag.name !== "svg")) reject("svg_unsupported");
      for (const [name, value] of Object.entries(tag.attributes)) {
        const key = name.toLowerCase().split(":").at(-1)!;
        if (value.includes("\\") || /[\x00-\x1f\x7f]/u.test(value)) reject("svg_unsupported");
        if (key.startsWith("on") || key === "style" || key === "base") reject("svg_unsupported");
        if (key === "href") {
          if (!/^#[A-Za-z_][A-Za-z0-9_.:-]{0,199}$/u.test(value)) reject("svg_unsupported");
        }
        if (/url\s*\(/iu.test(value) && !/^url\(#[A-Za-z_][A-Za-z0-9_.:-]{0,199}\)$/u.test(value)) reject("svg_unsupported");
      }
    });
    parser.on("closetag", () => { depth--; });
    parser.write(text).close();
    if (!nodes || depth !== 0) reject("svg_unsupported");
  } catch (error) {
    if (error instanceof ImageProcessingError) throw error;
    reject("svg_unsupported");
  }
}
function contractImageFormat(bytes: Buffer, reported: unknown): string {
  const format = String(reported);
  if (
    format === "heif" &&
    bytes.subarray(4, 8).toString("ascii") === "ftyp" &&
    /^(?:avif|avis)$/u.test(bytes.subarray(8, 12).toString("ascii"))
  ) {
    return "avif";
  }
  return format;
}

function sourceKind(bytes: Buffer): "raster" | "svg" {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
      /^GIF8[79]a/u.test(bytes.subarray(0, 6).toString("ascii")) ||
      (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") ||
      (bytes.subarray(4, 8).toString("ascii") === "ftyp" && /^(?:avif|avis)$/u.test(bytes.subarray(8, 12).toString("ascii")))) return "raster";
  if (bytes.subarray(0, 200).toString("utf8").trimStart().startsWith("<")) return "svg";
  reject("image_invalid");
}
export async function processImage(bytes: Buffer, policy: ImagePolicy): Promise<ProcessedImage> {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > ASSET_SOURCE_MAX_BYTES) reject("image_limit");
  if (!policy || !Number.isInteger(policy.quality) || policy.quality < 1 || policy.quality > 100 ||
      (policy.preserveOriginal !== undefined && typeof policy.preserveOriginal !== "boolean") ||
      (policy.preserveOriginal && (typeof policy.exceptionReason !== "string" || !policy.exceptionReason.trim() || policy.exceptionReason.length > 200))) reject("image_policy_invalid");
  // APNG and AVIF image sequences must not be silently flattened by a decoder
  // that exposes them as one frame. They are not in this V1's proven contract.
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let at = 8;
    while (at + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(at), type = bytes.subarray(at + 4, at + 8).toString("ascii");
      if (length > bytes.length - at - 12) reject("image_invalid");
      if (type === "acTL") reject("image_invalid");
      at += length + 12;
      if (type === "IEND") break;
    }
  }
  if (bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const length = bytes.readUInt32BE(0);
    if (length < 16 || length > bytes.length) reject("image_invalid");
    for (let at = 8; at + 4 <= length; at += 4) {
      if (bytes.subarray(at, at + 4).toString("ascii") === "avis") reject("image_invalid");
    }
  }
  const kind = sourceKind(bytes);
  if (kind === "svg") verifySvg(bytes);
  let sharp: any;
  try { sharp = createRequire(import.meta.url)("sharp"); }
  catch { reject("image_dependency_unavailable"); }
  sharp.cache(false);
  sharp.concurrency(1);
  const options = { failOn: "warning", limitInputPixels: ASSET_MAX_PIXELS, unlimited: false, animated: true };
  try {
    const metadata = await sharp(bytes, options).metadata();
    const format = contractImageFormat(bytes, metadata.format), pages = metadata.pages ?? 1;
    const width = Number(metadata.width), height = Number(metadata.pageHeight ?? metadata.height);
    if (!["jpeg", "png", "webp", "gif", "avif", "svg"].includes(format) ||
        !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        !Number.isInteger(pages) || pages < 1 || pages > 32 || width * height * pages > ASSET_MAX_PIXELS) reject("image_limit");
    if ((format === "svg") !== (kind === "svg")) reject("image_invalid");
    // Decode every accepted frame. Only buffers reach the decoder, never a URL/path.
    // The caller runs this function inside a separately bounded child process.
    await sharp(bytes, options).raw().timeout({ seconds: 3 }).toBuffer();
    const preserve = kind === "svg" || pages > 1 || policy.preserveOriginal;
    const output: Buffer = preserve ? Buffer.from(bytes) : await sharp(bytes, options)
      .rotate().webp({ quality: policy.quality, alphaQuality: 100 }).timeout({ seconds: 3 }).toBuffer();
    if (output.length > ASSET_MAX_BYTES) reject("image_limit");
    const final = await sharp(output, options).metadata();
    const finalFormat = contractImageFormat(output, final.format);
    const expectedWidth = !preserve && [5, 6, 7, 8].includes(metadata.orientation) ? height : width;
    const expectedHeight = !preserve && [5, 6, 7, 8].includes(metadata.orientation) ? width : height;
    if (final.width !== expectedWidth || (final.pageHeight ?? final.height) !== expectedHeight || (final.pages ?? 1) !== pages) reject("image_invalid");
    return {
      bytes: output, format: finalFormat, width: expectedWidth, height: expectedHeight, pages,
      hasAlpha: Boolean(final.hasAlpha), sourceSha256: assetHash(bytes), sha256: assetHash(output), size: output.length,
      encoderVersion: String(sharp.versions.sharp) + ":" + String(sharp.versions.vips),
      exception: kind === "svg" ? "vector_preserved" : pages > 1 ? "animation_preserved" : policy.preserveOriginal ? "original_requested" : "none",
    };
  } catch (error) {
    if (error instanceof ImageProcessingError) throw error;
    reject("image_invalid");
  }
}
