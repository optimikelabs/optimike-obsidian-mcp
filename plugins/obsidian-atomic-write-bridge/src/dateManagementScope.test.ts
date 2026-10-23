import test from "node:test";
import assert from "node:assert/strict";
import {
  dateManagementScope,
  excludedByFdmRules,
  createTemplateDateGuard,
} from "./dateManagementScope.js";

test("FDM ordered exclusions match folders, files, globs, negation and boundaries", () => {
  const rules =
    "# examples\nArchive\n!Archive/Keep/**\nArchive/Keep/private.md\n**/*.draft.md";
  for (const path of [
    "Archive/N.md",
    "Archive/Keep/private.md",
    "Notes/A.draft.md",
  ])
    assert.equal(excludedByFdmRules(path, rules), true, path);
  for (const path of ["Archives/N.md", "Archive/Keep/N.md", "Notes/A.md"])
    assert.equal(excludedByFdmRules(path, rules), false, path);
});

test("default templates, live Templater configuration and unloaded plugin configuration", async () => {
  const app = {
    plugins: { getPlugin: (_id: string): any => undefined },
    vault: {
      configDir: ".config",
      adapter: {
        exists: async (p: string) =>
          p.includes("templater-obsidian") ||
          p.includes("frontmatter-date-manager"),
        read: async (p: string) =>
          JSON.stringify(
            p.includes("templater-obsidian")
              ? { templates_folder: "My templates" }
              : { filterRules: "Archive" },
          ),
      },
    },
  };
  for (const p of ["X/Modèles/Projet.md", "My templates/A.md", "Archive/A.md"])
    assert.equal((await dateManagementScope(app, p)).managed, false, p);
  assert.equal(
    (await dateManagementScope(app, "X/Modèles bis/A.md")).managed,
    true,
  );
  assert.equal((await dateManagementScope(app, "Notes/A.md")).managed, true);
  app.plugins.getPlugin = (id) =>
    id === "templater-obsidian"
      ? { settings: { templates_folder: "Live" } }
      : undefined;
  assert.equal((await dateManagementScope(app, "Live/A.md")).managed, false);
});

test("template guard also prevents asynchronous FDM dating, preserves other paths and restores on unload", async () => {
  let calls = 0;
  const original = async () => {
    calls++;
    return { ignored: false };
  };
  const fdm = { shouldFileBeIgnored: original };
  const app = {
    plugins: {
      getPlugin: (id: string) =>
        id === "frontmatter-date-manager"
          ? fdm
          : { settings: { templates_folder: "Templates" } },
    },
  };
  const guard = createTemplateDateGuard(app);
  guard.ensure();
  guard.ensure();
  for (const path of ["X/Modèles/A.md", "Templates/A.md"])
    assert.equal(
      (await (fdm.shouldFileBeIgnored as any)({ path })).ignored,
      true,
    );
  assert.equal(calls, 0);
  assert.equal(
    (await (fdm.shouldFileBeIgnored as any)({ path: "Notes/A.md" })).ignored,
    false,
  );
  assert.equal(calls, 1);
  guard.dispose();
  assert.equal(fdm.shouldFileBeIgnored, original);
});
