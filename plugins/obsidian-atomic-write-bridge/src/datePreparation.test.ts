import test from "node:test";
import assert from "node:assert/strict";
import {
  createDatePreparation,
  MISSING_CREATION_MESSAGE,
} from "./datePreparation.js";
import { sha256, parseDatePreparationRequest } from "./contract.js";

function fixture() {
  let clock = 0,
    commands = 0,
    opens = 0,
    detaches = 0,
    enabled = true;
  const file = { path: "Test.md", extension: "md" };
  let content = "---\nstatut: actif\n---\nbody\n";
  const plugin = {
    settings: {
      enableAutoUpdate: true,
      enableCreateTime: true,
      headerCreated: "création",
      headerUpdated: "modification",
      dateFormat: "yyyy-MM-dd'T'HH:mm",
    },
  };
  const leaf = {
    openFile: async () => {
      opens++;
    },
    detach() {
      detaches++;
    },
  };
  const app: any = {
    vault: { getAbstractFileByPath: () => file, read: async () => content },
    plugins: {
      getPlugin: (id: string) =>
        id === "frontmatter-date-manager" ? plugin : undefined,
    },
    workspace: {
      activeLeaf: null,
      getLeaf: () => leaf,
      getActiveFile: () => file,
      setActiveLeaf(value: any) {
        this.activeLeaf = value;
      },
    },
    commands: {
      commands: {
        "frontmatter-date-manager:update-timestamps-current-file": {},
      },
      executeCommandById() {
        commands++;
        content = content.replace(
          "statut: actif",
          "statut: actif\ncréation: 2026-10-23T10:00\nmodification: 2026-10-23T10:00",
        );
        return true;
      },
    },
  };
  const parse = (yaml: string) =>
    Object.fromEntries(
      yaml.split("\n").map((line) => {
        const at = line.indexOf(":");
        return [line.slice(0, at), line.slice(at + 1).trim()];
      }),
    );
  const prepare = createDatePreparation(app, parse, {
    enabled: () => enabled,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    timeoutMs: 1500,
  });
  return {
    app,
    plugin,
    prepare,
    request: () => ({ path: file.path, expectedSha256: sha256(content) }),
    content: () => content,
    setContent: (v: string) => {
      content = v;
    },
    disable: () => {
      enabled = false;
    },
    counts: () => ({ commands, opens }),
    detached: () => detaches,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("undated note is dated only by FDM command, then reread with a receipt", async () => {
  const f = fixture();
  const result = await f.prepare(f.request());
  assert.equal(result.content, f.content());
  assert.match(result.content, /création: 2026/);
  assert.equal(result.datePreparation?.kind, "date-manager-before-plan");
  assert.equal(
    result.datePreparation?.message,
    "Note datée par le gestionnaire de dates avant le plan.",
  );
  assert.equal("lineEndingsNormalized" in result.datePreparation!, false);
  assert.equal(f.counts().commands, 1);
  await f.prepare(f.request());
  assert.equal(f.counts().commands, 1);
  assert.equal(f.counts().opens, 1);
});
for (const mode of [
  "missing",
  "disabled",
  "writes-off",
  "command-missing",
  "command-fails",
  "excluded",
]) {
  test(`fails closed with clear message: ${mode}`, async () => {
    const f = fixture();
    const before = f.content();
    if (mode === "missing") f.app.plugins.getPlugin = () => undefined;
    if (mode === "disabled") f.plugin.settings.enableAutoUpdate = false;
    if (mode === "writes-off") f.disable();
    if (mode === "command-missing") f.app.commands.commands = {};
    if (mode === "command-fails")
      f.app.commands.executeCommandById = () => false;
    if (mode === "excluded") f.app.commands.executeCommandById = () => true;
    await assert.rejects(f.prepare(f.request()), {
      message: MISSING_CREATION_MESSAGE,
    });
    assert.equal(f.content(), before);
  });
}
test("stale source is refused before any command or UI change", async () => {
  const f = fixture();
  const request = f.request();
  f.setContent(f.content() + "human edit");
  await assert.rejects(f.prepare(request), /changed after/);
  assert.deepEqual(f.counts(), { commands: 0, opens: 0 });
});
test("body edits during dating are conflicts", async () => {
  const f = fixture();
  const command = f.app.commands.executeCommandById;
  f.app.commands.executeCommandById = () => {
    command();
    f.setContent(f.content() + "human");
    return true;
  };
  await assert.rejects(f.prepare(f.request()), /changed after/);
});
test("preparation requests reject unbounded, traversal and extra inputs", () => {
  const valid = {
    contractVersion: 1,
    path: "Test.md",
    expectedSha256: "a".repeat(64),
    bindingFingerprint: "b".repeat(64),
  };
  assert.equal(parseDatePreparationRequest(valid).path, "Test.md");
  for (const bad of [
    { ...valid, path: "../Test.md" },
    { ...valid, création: "fake" },
    { ...valid, expectedSha256: "bad" },
  ])
    assert.throws(() => parseDatePreparationRequest(bad));
});

test("unload cancels queued preparations before their command", async () => {
  const f = fixture();
  f.prepare.dispose();
  await assert.rejects(f.prepare(f.request()), {
    message: MISSING_CREATION_MESSAGE,
  });
  assert.equal(f.counts().commands, 0);
});
test("concurrent same-source preparations serialize and the loser cannot date again", async () => {
  const f = fixture(),
    request = f.request();
  const results = await Promise.allSettled([
    f.prepare(request),
    f.prepare(request),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(f.counts().commands, 1);
});
test("metadata edits during dating are conflicts", async () => {
  const f = fixture(),
    command = f.app.commands.executeCommandById;
  f.app.commands.executeCommandById = () => {
    command();
    f.setContent(f.content().replace("statut: actif", "statut: clos"));
    return true;
  };
  await assert.rejects(f.prepare(f.request()), /changed after/);
});

for (const path of ["X/Modèles/A.md", "Excluded/A.md", "Templates/A.md"]) {
  test(`outside date management never opens or dates ${path}`, async () => {
    const f = fixture();
    Object.assign(f.plugin.settings, { filterRules: "Excluded" });
    const getPlugin = f.app.plugins.getPlugin;
    f.app.plugins.getPlugin = (id: string) =>
      id === "templater-obsidian"
        ? { settings: { templates_folder: "Templates" } }
        : getPlugin(id);
    const before = f.content();
    const result = await f.prepare({ ...f.request(), path });
    assert.equal(result.datePreparation?.kind, "outside-date-management");
    assert.equal(result.content, before);
    assert.deepEqual(f.counts(), { commands: 0, opens: 0 });
  });
}

test("native editor close normalizes CRLF to LF with a receipt", async () => {
  const f = fixture();
  f.setContent(f.content().replace(/\n/g, "\r\n"));
  f.app.workspace.getLeaf().detach = () => {
    f.setContent(f.content().replace(/\r\n/g, "\n"));
  };
  const result = await f.prepare(f.request());
  assert.equal(result.content, f.content());
  assert.match(
    result.datePreparation!.message,
    /fins de ligne normalisées par Obsidian pendant la datation/,
  );
});

test("a non-date edit flushed on native editor close remains a conflict", async () => {
  const f = fixture();
  f.app.workspace.getLeaf().detach = () =>
    f.setContent(f.content() + "human edit");
  await assert.rejects(f.prepare(f.request()), /changed after/);
});

test("review P1: a queued request expires from arrival and never dispatches FDM", async () => {
  const f = fixture();
  const command = f.app.commands.executeCommandById;
  let dispatches = 0;
  f.app.commands.executeCommandById = () => {
    dispatches++;
    // The first manager command never produces a date and consumes its budget.
    return dispatches === 1 ? true : command();
  };
  const request = f.request();
  const results = await Promise.allSettled([
    f.prepare(request),
    f.prepare(request),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["rejected", "rejected"],
  );
  assert.equal(dispatches, 1);
  assert.equal(f.counts().opens, 1);
});

test("review P1: time spent opening the note cannot extend the command deadline", async () => {
  const f = fixture();
  f.app.workspace.getLeaf().openFile = async () => {
    f.advance(1500);
  };
  await assert.rejects(f.prepare(f.request()), {
    message: MISSING_CREATION_MESSAGE,
  });
  assert.equal(f.counts().commands, 0);
  assert.equal(f.detached(), 1);
});

test("review P1: do not dispatch without the minimum remaining settlement budget", async () => {
  const f = fixture();
  f.app.workspace.getLeaf().openFile = async () => {
    f.advance(1000);
  };
  await assert.rejects(f.prepare(f.request()), {
    message: MISSING_CREATION_MESSAGE,
  });
  assert.equal(f.counts().commands, 0);
});

for (const [name, body, convert] of [
  ["CRLF to LF", "body\r\nnext\r\n", (s: string) => s.replace(/\r\n/g, "\n")],
  ["LF to CRLF", "body\nnext\n", (s: string) => s.replace(/\r?\n/g, "\r\n")],
  [
    "mixed endings to LF",
    "body\r\nnext\n",
    (s: string) => s.replace(/\r\n/g, "\n"),
  ],
] as const) {
  test(`FDM accepts only line-ending normalization: ${name}`, async () => {
    const f = fixture();
    f.setContent("---\nstatut: actif\n---\n" + body);
    const command = f.app.commands.executeCommandById;
    f.app.commands.executeCommandById = () => {
      command();
      f.setContent(convert(f.content()));
      return true;
    };
    const result = await f.prepare(f.request());
    assert.equal(result.content, f.content());
    assert.match(
      result.datePreparation!.message,
      /fins de ligne normalisées par Obsidian pendant la datation/,
    );
    assert.equal(
      "lineEndingsNormalized" in result.datePreparation! &&
        result.datePreparation.lineEndingsNormalized,
      true,
    );
  });
}

for (const replacement of [
  "word",
  "bod",
  "body!",
  "body ",
  "body\n",
  "bo\rdy",
]) {
  test(`CRLF normalization does not hide a body edit: ${JSON.stringify(replacement)}`, async () => {
    const f = fixture();
    f.setContent(f.content().replace(/\n/g, "\r\n"));
    const command = f.app.commands.executeCommandById;
    f.app.commands.executeCommandById = () => {
      command();
      f.setContent(
        f.content().replace(/\r\n/g, "\n").replace("body", replacement),
      );
      return true;
    };
    await assert.rejects(f.prepare(f.request()), /changed after/);
  });
}

test("CRLF body preserved by FDM remains accepted", async () => {
  const f = fixture();
  f.setContent(f.content().replace(/\n/g, "\r\n"));
  const before = f.content().split("---\r\n")[2];
  const result = await f.prepare(f.request());
  assert.equal(
    result.content.slice(result.content.lastIndexOf("---\r\n") + 5),
    before,
  );
});

for (const conflict of [false, true]) {
  test(`review P2: temporary leaf detaches after focus changed (conflict=${conflict})`, async () => {
    const f = fixture();
    const otherLeaf = {};
    const command = f.app.commands.executeCommandById;
    f.app.commands.executeCommandById = () => {
      command();
      f.app.workspace.activeLeaf = otherLeaf;
      if (conflict) f.setContent(f.content() + "human edit");
      return true;
    };
    if (conflict) await assert.rejects(f.prepare(f.request()), /changed after/);
    else await f.prepare(f.request());
    assert.equal(f.detached(), 1);
    assert.equal(f.app.workspace.activeLeaf, otherLeaf);
  });
}

test("native editor close is settled before returning the prepared content", async () => {
  const f = fixture();
  f.app.workspace.getLeaf().detach = () => {
    f.setContent(
      f
        .content()
        .replace(
          "modification: 2026-10-23T10:00",
          "modification: 2026-10-23T10:01",
        ),
    );
  };
  const result = await f.prepare(f.request());
  assert.equal(result.content, f.content());
  assert.match(result.content, /modification: 2026-10-23T10:01/);
});

test("CRLF conversion cannot conceal a non-date property change", async () => {
  const f = fixture();
  f.setContent(f.content().replace(/\n/g, "\r\n"));
  const command = f.app.commands.executeCommandById;
  f.app.commands.executeCommandById = () => {
    command();
    f.setContent(
      f
        .content()
        .replace(/\r\n/g, "\n")
        .replace("statut: actif", "statut: clos"),
    );
    return true;
  };
  await assert.rejects(f.prepare(f.request()), /changed after/);
});
