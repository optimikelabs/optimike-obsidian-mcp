export type NoteLinkReferenceKind = "link" | "embed" | "frontmatter";

export type NoteLinkPosition = {
  start: { line: number; col: number; offset: number };
  end: { line: number; col: number; offset: number };
};

export type NoteLinkReferenceInput = {
  link: string;
  original: string;
  displayText?: string;
  position?: NoteLinkPosition;
  key?: string;
};

export type NoteSubpathValidation =
  | { status: "not_requested" }
  | { status: "valid"; type: "heading" | "block" | "footnote" }
  | { status: "invalid" }
  | {
      status: "unknown";
      reason: "target_file_unavailable" | "target_cache_unavailable";
    };

export type NoteLinkObservation = {
  kind: NoteLinkReferenceKind;
  linkText: string;
  original: string;
  displayText?: string;
  frontmatterKey?: string;
  position?: NoteLinkPosition;
  linkPath: string;
  subpath: string;
  resolution:
    | { status: "resolved"; targetPath: string }
    | { status: "unresolved" };
  subpathValidation: NoteSubpathValidation;
  provenance:
    | "metadataCache.links"
    | "metadataCache.embeds"
    | "metadataCache.frontmatterLinks";
};

export type NoteLinksProjection = {
  outgoing: NoteLinkObservation[];
  unresolved: Array<{ linkText: string; count: number }>;
  backlinks: Array<{ sourcePath: string; count: number }>;
  coverage: {
    outgoing: { total: number; returned: number; truncated: boolean };
    unresolved: { total: number; returned: number; truncated: boolean };
    backlinks: { total: number; returned: number; truncated: boolean };
  };
};

export type ProjectNoteLinksInput = {
  sourcePath: string;
  cacheAvailable: boolean;
  links: readonly NoteLinkReferenceInput[];
  embeds: readonly NoteLinkReferenceInput[];
  frontmatterLinks: readonly NoteLinkReferenceInput[];
  resolvedLinks: Readonly<Record<string, Readonly<Record<string, number>>>>;
  unresolvedLinks: Readonly<Record<string, Readonly<Record<string, number>>>>;
  limit: number;
  parseLinktext: (linkText: string) => { path: string; subpath: string };
  resolveLink: (linkPath: string, sourcePath: string) => string | null;
  validateSubpath: (
    targetPath: string,
    subpath: string,
  ) => NoteSubpathValidation;
};

function bounded<T>(items: T[], limit: number) {
  return {
    values: items.slice(0, limit),
    coverage: {
      total: items.length,
      returned: Math.min(items.length, limit),
      truncated: items.length > limit,
    },
  };
}

function sourceOffset(reference: NoteLinkReferenceInput): number {
  return reference.position?.start.offset ?? -1;
}

function kindOrder(kind: NoteLinkReferenceKind): number {
  if (kind === "frontmatter") return 0;
  if (kind === "link") return 1;
  return 2;
}

export function projectNoteLinks(
  input: ProjectNoteLinksInput,
): NoteLinksProjection {
  const references: Array<{
    kind: NoteLinkReferenceKind;
    provenance: NoteLinkObservation["provenance"];
    reference: NoteLinkReferenceInput;
  }> = [
    ...input.links.map((reference) => ({
      kind: "link" as const,
      provenance: "metadataCache.links" as const,
      reference,
    })),
    ...input.embeds.map((reference) => ({
      kind: "embed" as const,
      provenance: "metadataCache.embeds" as const,
      reference,
    })),
    ...input.frontmatterLinks.map((reference) => ({
      kind: "frontmatter" as const,
      provenance: "metadataCache.frontmatterLinks" as const,
      reference,
    })),
  ].sort((left, right) => {
    const offsetDelta =
      sourceOffset(left.reference) - sourceOffset(right.reference);
    if (offsetDelta !== 0) return offsetDelta;
    const typeDelta = kindOrder(left.kind) - kindOrder(right.kind);
    if (typeDelta !== 0) return typeDelta;
    return left.reference.original.localeCompare(right.reference.original);
  });

  const outgoing = references.map(({ kind, provenance, reference }) => {
    const parsed = input.parseLinktext(reference.link);
    const targetPath =
      parsed.path.length === 0
        ? input.sourcePath
        : input.resolveLink(parsed.path, input.sourcePath);
    const resolution: NoteLinkObservation["resolution"] = targetPath
      ? { status: "resolved", targetPath }
      : { status: "unresolved" };
    const subpathValidation: NoteSubpathValidation =
      parsed.subpath.length === 0
        ? { status: "not_requested" }
        : targetPath
          ? input.validateSubpath(targetPath, parsed.subpath)
          : { status: "unknown", reason: "target_file_unavailable" };

    return {
      kind,
      linkText: reference.link,
      original: reference.original,
      ...(reference.displayText ? { displayText: reference.displayText } : {}),
      ...(kind === "frontmatter" && reference.key
        ? { frontmatterKey: reference.key }
        : {}),
      ...(reference.position ? { position: reference.position } : {}),
      linkPath: parsed.path,
      subpath: parsed.subpath,
      resolution,
      subpathValidation,
      provenance,
    };
  });

  const unresolved = Object.entries(
    input.unresolvedLinks[input.sourcePath] ?? {},
  )
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .map(([linkText, count]) => ({ linkText, count }))
    .sort((left, right) => left.linkText.localeCompare(right.linkText));

  const backlinks = Object.entries(input.resolvedLinks)
    .flatMap(([sourcePath, destinations]) => {
      const count = destinations[input.sourcePath] ?? 0;
      return Number.isFinite(count) && count > 0
        ? [{ sourcePath, count }]
        : [];
    })
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));

  const boundedOutgoing = bounded(outgoing, input.limit);
  const boundedUnresolved = bounded(unresolved, input.limit);
  const boundedBacklinks = bounded(backlinks, input.limit);

  return {
    outgoing: input.cacheAvailable ? boundedOutgoing.values : [],
    unresolved: boundedUnresolved.values,
    backlinks: boundedBacklinks.values,
    coverage: {
      outgoing: input.cacheAvailable
        ? boundedOutgoing.coverage
        : { total: 0, returned: 0, truncated: false },
      unresolved: boundedUnresolved.coverage,
      backlinks: boundedBacklinks.coverage,
    },
  };
}
