import { isDeepStrictEqual } from "node:util";
import { isMap, parseDocument } from "yaml";
import type { NoteJson } from "./types.js";

export interface FrontmatterReadSignal {
  metadataCacheStale?: { keys: string[] };
}

const OPENING_FENCE = /^\uFEFF?---[ \t]*\r?\n/u;
const CLOSING_FENCE = /^---[ \t]*\r?$/mu;

function parseContentFrontmatter(content: string): NoteJson["frontmatter"] | undefined {
  const opening = OPENING_FENCE.exec(content);
  if (!opening) return {};

  const afterOpening = content.slice(opening[0].length);
  const closing = CLOSING_FENCE.exec(afterOpening);
  if (!closing) return undefined;

  try {
    const document = parseDocument(afterOpening.slice(0, closing.index), {
      schema: "core",
      version: "1.2",
      resolveKnownTags: false,
    });
    if (document.errors.length || document.warnings.length) return undefined;
    if (document.contents === null) return {};
    if (!isMap(document.contents)) return undefined;

    // Compare in the same JSON representation as REST. This also rejects cycles.
    const frontmatter = JSON.parse(JSON.stringify(document.toJS({ maxAliasCount: 100 })));
    // Local REST strips Obsidian's reserved position property from its response.
    delete frontmatter.position;
    return frontmatter;
  } catch {
    return undefined;
  }
}

/** Reconcile the two sources in a single Local REST note response, for reads only. */
export function resolveReadFrontmatter(
  note: NoteJson,
): Pick<NoteJson, "frontmatter"> & FrontmatterReadSignal {
  const cached = note.frontmatter;
  const unchanged = { frontmatter: cached };
  if (typeof note.content !== "string" || !cached ||
      typeof cached !== "object" || Array.isArray(cached)) return unchanged;

  const frontmatter = parseContentFrontmatter(note.content);
  if (!frontmatter) return unchanged;

  const keys = [...new Set([...Object.keys(cached), ...Object.keys(frontmatter)])]
    .filter((key) => Object.hasOwn(cached, key) !== Object.hasOwn(frontmatter, key) ||
      !isDeepStrictEqual(cached[key], frontmatter[key]));
  if (keys.length === 0) return unchanged;

  return { frontmatter, metadataCacheStale: { keys: keys.sort() } };
}
