import { dateManagementScope } from "./dateManagementScope.js";
import { isDeepStrictEqual } from "node:util";
import { getFrontmatterDateIntegrationContract } from "./modifiedTimeIntegrations.js";
import { sha256, HashConflictError } from "./contract.js";

export const DATE_PREPARATION_MESSAGE =
  "Note datée par le gestionnaire de dates avant le plan.";
export const MISSING_CREATION_MESSAGE =
  "Cette note n'a pas encore de date de création. Ouvrez-la dans Obsidian et enregistrez-la une fois, puis réessayez.";
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
    const normalized = content.replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---\n"))
      return { properties: {}, body: normalized };
    const end = normalized.indexOf("\n---\n", 4);
    if (end < 0) throw Error(MISSING_CREATION_MESSAGE);
    const properties = parse(normalized.slice(4, end));
    if (
      !properties ||
      typeof properties !== "object" ||
      Array.isArray(properties)
    )
      throw Error(MISSING_CREATION_MESSAGE);
    return { properties, body: normalized.slice(end + 5) };
  }
  const prepare = (request: { path: string; expectedSha256: string }) => {
    const run = async () => {
      const fail = () => {
        throw Error(MISSING_CREATION_MESSAGE);
      };
      if (disposed || !options.enabled()) return fail();
      const scope = await dateManagementScope(app, request.path);
      if (!scope.managed) {
        const content = await app.vault.read(
          app.vault.getAbstractFileByPath(request.path),
        );
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
      const previous = app.workspace.activeLeaf;
      const leaf = app.workspace.getLeaf("tab");
      try {
        await leaf.openFile(file, { state: { mode: "source" }, active: true });
        app.workspace.setActiveLeaf(leaf, { focus: false });
        // Recheck after opening: native saves and other editors may have run meanwhile.
        const current = await app.vault.read(file);
        if (sha256(current) !== request.expectedSha256)
          throw new HashConflictError(sha256(current));
        if (
          disposed ||
          !options.enabled() ||
          app.plugins.getPlugin("frontmatter-date-manager") !== plugin ||
          JSON.stringify(getFrontmatterDateIntegrationContract(app)) !==
            policy ||
          app.workspace.getActiveFile() !== file
        )
          return fail();
        if (!app.commands.executeCommandById(COMMAND)) return fail();
        const deadline = now() + (options.timeoutMs ?? 55_000);
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
          const observed = envelope(content);
          // A body edit while FDM runs is a conflict; never silently fold it into the plan.
          if (
            observed.body !== before.body ||
            !isDeepStrictEqual(
              nonDates(observed.properties),
              nonDates(before.properties),
            )
          )
            throw new HashConflictError(sha256(content));
          if (content !== last) {
            last = content;
            stableSince = now();
          }
          if (hasCreated(observed.properties) && now() - stableSince >= 1_000)
            return {
              content,
              datePreparation: {
                kind: "date-manager-before-plan" as const,
                message: DATE_PREPARATION_MESSAGE,
              },
            };
          await sleep(100);
        }
        return fail();
      } finally {
        // Never steal focus back from a user who moved to another note.
        if (app.workspace.activeLeaf === leaf) {
          if (previous) app.workspace.setActiveLeaf(previous, { focus: false });
          leaf.detach();
        }
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
