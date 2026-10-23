import picomatch from "picomatch/posix.js";

export type DateManagementScope = {
  managed: boolean;
  reason?: "default-templates" | "templater" | "fdm-filter";
};

const inside = (path: string, folder: unknown): boolean => {
  if (typeof folder !== "string" || !folder.trim()) return false;
  const root = folder
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return Boolean(root) && path.startsWith(root + "/");
};

// FDM 1.6.0 filterRules semantics: ordered picomatch POSIX rules, last match wins.
// Read persisted settings as well when a plugin is not loaded.
async function settingsFor(app: any, id: string) {
  const loaded = app.plugins?.getPlugin?.(id)?.settings;
  if (loaded) return loaded;
  const config = `${app.vault.configDir ?? ".obsidian"}/plugins/${id}/data.json`;
  if (app.vault.adapter?.exists && (await app.vault.adapter.exists(config)))
    return JSON.parse(await app.vault.adapter.read(config));
  return undefined;
}

export function excludedByFdmRules(path: string, rules: unknown): boolean {
  if (typeof rules !== "string") return false;
  let excluded = false;
  for (const line of rules.split("\n")) {
    const value = line.trim();
    if (!value || value.startsWith("#")) continue;
    const negate = value.startsWith("!");
    const pattern = (negate ? value.slice(1) : value).trim();
    if (!pattern) continue;
    let matches = false;
    if (/[*?[{]/.test(pattern)) {
      try {
        matches = picomatch.isMatch(path, pattern);
      } catch {
        continue;
      }
    } else
      matches =
        path === pattern ||
        path.startsWith(pattern.endsWith("/") ? pattern : pattern + "/");
    if (matches) excluded = !negate;
  }
  return excluded;
}

// FDM also reacts asynchronously to vault.modify. A template exception must
// cover that callback, not just the explicit preparation command. This scoped
// runtime hook never edits FDM settings or note properties and is removed on
// Bridge unload. Ordinary paths always retain FDM's original behavior.
export function createTemplateDateGuard(app: any) {
  const installed = new Map<any, { original: any; wrapped: any }>();
  return {
    ensure() {
      const fdm = app.plugins?.getPlugin?.("frontmatter-date-manager");
      if (
        !fdm ||
        installed.has(fdm) ||
        typeof fdm.shouldFileBeIgnored !== "function"
      )
        return;
      for (const [previous, { original, wrapped }] of installed) {
        if (previous.shouldFileBeIgnored === wrapped)
          previous.shouldFileBeIgnored = original;
      }
      installed.clear();
      const original = fdm.shouldFileBeIgnored;
      const wrapped = async function (this: any, file: any, ...args: any[]) {
        const templater = await settingsFor(app, "templater-obsidian");
        if (
          inside(file?.path ?? "", "X/Modèles") ||
          inside(file?.path ?? "", templater?.templates_folder)
        )
          return { ignored: true, reason: "filter-rule" };
        return original.call(this, file, ...args);
      };
      installed.set(fdm, { original, wrapped });
      fdm.shouldFileBeIgnored = wrapped;
    },
    dispose() {
      for (const [fdm, { original, wrapped }] of installed)
        if (fdm.shouldFileBeIgnored === wrapped)
          fdm.shouldFileBeIgnored = original;
      installed.clear();
    },
  };
}

export async function dateManagementScope(
  app: any,
  path: string,
): Promise<DateManagementScope> {
  if (inside(path, "X/Modèles"))
    return { managed: false, reason: "default-templates" };
  const settings = await settingsFor(app, "templater-obsidian");
  if (inside(path, settings?.templates_folder))
    return { managed: false, reason: "templater" };
  const fdm = await settingsFor(app, "frontmatter-date-manager");
  if (excludedByFdmRules(path, fdm?.filterRules))
    return { managed: false, reason: "fdm-filter" };
  return { managed: true };
}
