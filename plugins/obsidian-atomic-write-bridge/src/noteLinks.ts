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
    outgoing: {
      available: boolean;
      total: number | null;
      returned: number;
      truncated: boolean;
    };
    unresolved: {
      available: true;
      total: number;
      returned: number;
      truncated: boolean;
    };
    backlinks: {
      available: true;
      total: number;
      returned: number;
      truncated: boolean;
    };
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
      available: true as const,
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

  const outgoingCoverage = {
    available: true as const,
    total: references.length,
    returned: Math.min(references.length, input.limit),
    truncated: references.length > input.limit,
  };
  const outgoing = references
    .slice(0, input.limit)
    .map(({ kind, provenance, reference }) => {
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

  const boundedUnresolved = bounded(unresolved, input.limit);
  const boundedBacklinks = bounded(backlinks, input.limit);

  return {
    outgoing: input.cacheAvailable ? outgoing : [],
    unresolved: boundedUnresolved.values,
    backlinks: boundedBacklinks.values,
    coverage: {
      outgoing: input.cacheAvailable
        ? outgoingCoverage
        : {
            available: false,
            total: null,
            returned: 0,
            truncated: false,
          },
      unresolved: boundedUnresolved.coverage,
      backlinks: boundedBacklinks.coverage,
    },
  };
}
