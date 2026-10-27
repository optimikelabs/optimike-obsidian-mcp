import { dateManagementScope } from "./dateManagementScope.js";
import { isDeepStrictEqual } from "node:util";
import { getFrontmatterDateIntegrationContract } from "./modifiedTimeIntegrations.js";
import { sha256, HashConflictError } from "./contract.js";

export const DATE_PREPARATION_MESSAGE =
  "Note datée par le gestionnaire de dates avant le plan.";
export const MISSING_CREATION_MESSAGE =
  "Cette note n'a pas encore de date de création. Ouvrez-la dans Obsidian et enregistrez-la une fois, puis réessayez.";
export class DatePreparationError extends Error {}
const POLL_MS = 100;
const STABLE_MS = 1_000;
const COMMAND_SETTLEMENT_BUDGET_MS = STABLE_MS + 2 * POLL_MS;
const COMMAND = "frontmatter-date-manager:update-timestamps-current-file";

// All current-file commands share one queue: two requests must never date each other's note.
export function createDatePreparation(
  app: any,
  parse: (yaml: string) => any,
  options: {
    enabled: () => boolean;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  },
) {
  let tail: Promise<unknown> = Promise.resolve();
  let disposed = false;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  function envelope(content: string) {
    const opening = /^---\r?\n/.exec(content);
    if (!opening) return { properties: {}, body: content };
    const delimiter = /^---(?:\r?\n|$)/gm;
    delimiter.lastIndex = opening[0].length;
    const closing = delimiter.exec(content);
    if (!closing) throw new DatePreparationError(MISSING_CREATION_MESSAGE);
    // Normalize only the YAML input. The body remains byte-for-byte as read.
    const properties = parse(
      content.slice(opening[0].length, closing.index).replace(/\r\n/g, "\n"),
    );
    if (
      !properties ||
      typeof properties !== "object" ||
      Array.isArray(properties)
    )
      throw new DatePreparationError(MISSING_CREATION_MESSAGE);
    return {
      properties,
      body: content.slice(closing.index + closing[0].length),
    };
  }
  const prepare = (request: { path: string; expectedSha256: string }) => {
    // Queueing and native I/O consume this request's budget too.
    const deadline = now() + (options.timeoutMs ?? 55_000);
    const run = async () => {
      const fail = () => {
        throw new DatePreparationError(MISSING_CREATION_MESSAGE);
      };
      if (disposed || !options.enabled() || now() >= deadline) return fail();
      const scope = await dateManagementScope(app, request.path);
      if (now() >= deadline) return fail();
      if (!scope.managed) {
        const content = await app.vault.read(
          app.vault.getAbstractFileByPath(request.path),
        );
        if (now() >= deadline) return fail();
        if (sha256(content) !== request.expectedSha256)
          throw new HashConflictError(sha256(content));
        return {
          content,
          datePreparation: {
            kind: "outside-date-management" as const,
            message: "Note hors gestion des dates.",
          },
        };
      }
      const plugin = app.plugins?.getPlugin?.("frontmatter-date-manager");
      const contract = getFrontmatterDateIntegrationContract(app);
      const dates = contract.protectionIntegrations;
      const fdm = dates.find(
        (item) => item.pluginId === "frontmatter-date-manager",
      );
      if (
        !plugin ||
        !fdm?.createdPropertyName ||
        contract.unsupportedIntegrations.length ||
        dates.length !== 1 ||
        !app.commands?.commands?.[COMMAND]
      )
        return fail();
      const policy = JSON.stringify(contract);
      const file = app.vault.getAbstractFileByPath(request.path);
      if (!file || file.extension !== "md") return fail();
      const original = await app.vault.read(file);
      if (now() >= deadline) return fail();
      if (sha256(original) !== request.expectedSha256)
        throw new HashConflictError(sha256(original));
      const before = envelope(original);
      const hasCreated = (fm: Record<string, unknown>) => {
        const entries = Object.entries(fm).filter(
          ([key]) =>
            key.trim().toLowerCase() === fdm.createdPropertyName!.toLowerCase(),
        );
        return (
          entries.length === 1 &&
          typeof entries[0][1] === "string" &&
          entries[0][1].length > 0
        );
      };
      if (hasCreated(before.properties)) return { content: original };
      const dateKeys = new Set(
        [fdm.createdPropertyName, fdm.modifiedPropertyName]
          .filter(Boolean)
          .map((key) => key!.toLowerCase()),
      );
      const nonDates = (properties: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(properties).filter(
            ([key]) => !dateKeys.has(key.toLowerCase()),
          ),
        );
      if (deadline - now() < COMMAND_SETTLEMENT_BUDGET_MS) return fail();
      const previous = app.workspace.activeLeaf;
      const leaf = app.workspace.getLeaf("tab");
      let leafReleased = false;
      const releaseLeaf = () => {
        if (leafReleased) return;
        leafReleased = true;
        // Restore focus only if still ours; always release our temporary leaf.
        // Observe any native save before returning, including line-ending normalization.
        if (app.workspace.activeLeaf === leaf && previous)
          app.workspace.setActiveLeaf(previous, { focus: false });
        leaf.detach();
      };
      try {
        await leaf.openFile(file, { state: { mode: "source" }, active: true });
        app.workspace.setActiveLeaf(leaf, { focus: false });
        // Recheck after opening: native saves and other editors may have run meanwhile.
        const current = await app.vault.read(file);
        if (sha256(current) !== request.expectedSha256)
          throw new HashConflictError(sha256(current));
        if (
          disposed ||
          deadline - now() < COMMAND_SETTLEMENT_BUDGET_MS ||
          !options.enabled() ||
          app.plugins.getPlugin("frontmatter-date-manager") !== plugin ||
          JSON.stringify(getFrontmatterDateIntegrationContract(app)) !==
            policy ||
          app.workspace.getActiveFile() !== file
        )
          return fail();
        if (!app.commands.executeCommandById(COMMAND)) return fail();
        let last = "",
          stableSince = now();
        while (now() < deadline) {
          if (
            disposed ||
            !options.enabled() ||
            app.plugins.getPlugin("frontmatter-date-manager") !== plugin ||
            JSON.stringify(getFrontmatterDateIntegrationContract(app)) !==
              policy
          )
            return fail();
          const content = await app.vault.read(file);
          if (now() >= deadline) return fail();
          const observed = envelope(content);
          // Only CRLF/LF conversion is tolerated during native dating; all other body edits conflict.
          if (
            observed.body.replace(/\r\n/g, "\n") !==
              before.body.replace(/\r\n/g, "\n") ||
            !isDeepStrictEqual(
              nonDates(observed.properties),
              nonDates(before.properties),
            )
          )
            throw new HashConflictError(sha256(content));
          if (hasCreated(observed.properties) && !leafReleased) {
            releaseLeaf();
            last = "";
            stableSince = now();
            await sleep(POLL_MS);
            continue;
          }
          if (content !== last) {
            last = content;
            stableSince = now();
          }
          if (
            hasCreated(observed.properties) &&
            now() - stableSince >= STABLE_MS
          )
            return {
              content,
              datePreparation: {
                kind: "date-manager-before-plan" as const,
                message:
                  DATE_PREPARATION_MESSAGE +
                  (observed.body !== before.body
                    ? " fins de ligne normalisées par Obsidian pendant la datation."
                    : ""),
                ...(observed.body !== before.body
                  ? { lineEndingsNormalized: true as const }
                  : {}),
              },
            };
          await sleep(POLL_MS);
        }
        return fail();
      } finally {
        // Never steal focus back from a user who moved to another note.
        releaseLeaf();
      }
    };
    const result = tail.then(run);
    tail = result.catch(() => undefined);
    return result;
  };
  prepare.dispose = () => {
    disposed = true;
  };
  return prepare;
}
