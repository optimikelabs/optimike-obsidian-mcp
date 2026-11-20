import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { parseNoteInspectRequest } from "./contract.js";
import {
  createNoteInspector,
  NOTE_INSPECT_MAX_FINDINGS,
  NOTE_INSPECT_MAX_SUGGESTIONS,
  suggestCalloutTypes,
  valueFitsType,
  type NoteInspectApp,
  type StyleSheetLike,
} from "./noteInspect.js";

// Minimal synthetic stand-in for the Obsidian API the inspector reads:
// metadataCache (resolution + target caches), vault reads, type manager and
// loaded stylesheets. Subpath rules come from Obsidian at runtime; the fixture
// matches heading text and block ids exactly.

type Cache = { headings?: Array<{ heading: string }>; blocks?: Record<string, unknown> };

function parseLinktext(linktext: string) {
  const hash = linktext.indexOf("#");
  return hash < 0
    ? { path: linktext, subpath: "" }
    : { path: linktext.slice(0, hash), subpath: linktext.slice(hash) };
}

function resolveSubpath(cache: unknown, subpath: string) {
  const value = subpath.replace(/^#/u, "");
  const { headings = [], blocks = {} } = cache as Cache;
  if (value.startsWith("^")) return value.slice(1).toLowerCase() in blocks ? { type: "block" } : null;
  return headings.some((item) => item.heading === value) ? { type: "heading" } : null;
}

// Frontmatter in these fixtures is flat `key: value` YAML.
function parseYaml(yaml: string): unknown {
  const result: Record<string, unknown> = {};
  for (const line of yaml.split(/\r?\n/u)) {
    const match = /^([^:]+):\s*(.*)$/u.exec(line);
    if (!match) continue;
    const raw = match[2].trim();
    result[match[1].trim()] =
      raw === "true" ? true : raw === "false" ? false : /^-?\d+(\.\d+)?$/u.test(raw) ? Number(raw) : raw.replace(/^"(.*)"$/u, "$1");
  }
  return result;
}

function sheet(...selectors: string[]): StyleSheetLike {
  return { cssRules: selectors.map((selectorText) => ({ selectorText })) };
}

function fixture(options: {
  files?: Record<string, { content?: string; cache?: Cache }>;
  types?: Record<string, string>;
  typesJson?: string;
  sheets?: StyleSheetLike[];
  suggest?: typeof suggestCalloutTypes;
} = {}) {
  const files = options.files ?? {};
  const reads: string[] = [];
  const app: NoteInspectApp = {
    metadataCache: {
      getFirstLinkpathDest(linkpath) {
        const path = Object.keys(files).find((candidate) =>
          candidate === linkpath || candidate === `${linkpath}.md` || candidate.endsWith(`/${linkpath}.md`),
        );
        return path ? { path } : null;
      },
      getFileCache(file) {
        return files[file.path]?.cache ?? null;
      },
    },
    vault: {
      configDir: ".obsidian",
      getAbstractFileByPath(path) {
        return path in files ? { path } : null;
      },
      async cachedRead(file) {
        return files[file.path]?.content ?? "";
      },
      adapter: {
        async read(path) {
          reads.push(path);
          if (options.typesJson === undefined) throw new Error("missing");
          return options.typesJson;
        },
      },
    },
    ...(options.types
      ? { metadataTypeManager: { getAssignedWidget: (key: string) => options.types![key.toLowerCase()] ?? null } }
      : {}),
  };
  let sheets = options.sheets ?? [];
  const inspector = createNoteInspector({
    app,
    styleSheets: () => sheets,
    isFile: (value): value is { path: string } => value !== null && typeof value === "object",
    parseLinktext,
    parseYaml,
    resolveSubpath,
    ...(options.suggest ? { suggestCalloutTypes: options.suggest } : {}),
  });
  return { inspector, reads, setSheets: (next: StyleSheetLike[]) => (sheets = next) };
}

const codes = (findings: Array<{ code: string; target: string }>) =>
  findings.map((finding) => `${finding.code}:${finding.target}`);

test("reports the 2026-11-20 reference note: missing note, heading, block, embed, callout and datetime", async () => {
  const { inspector } = fixture({
    files: { "AGENTS.md": { cache: { headings: [{ heading: "Rules" }], blocks: { known: {} } } } },
    types: { "création": "datetime" },
  });
  const content = [
    "---",
    "création: pas une date",
    'up: "[[Note qui n existe pas zz]]"',
    "---",
    "[[Note qui n existe pas zz]]  [[AGENTS#Section inexistante zz]]  [[AGENTS#^blocinexistantzz]]  ![[image-absente-zz.png]]",
    "> [!calloutinventezz] Titre",
  ].join("\n");
  const result = await inspector.inspect({ path: "Inbox/Draft.md", content, baseline: "current_file" });

  assert.equal(result.baseline, "none");
  assert.deepEqual(codes(result.findings).sort(), [
    "embed-unresolved:image-absente-zz.png",
    "link-block-missing:AGENTS#^blocinexistantzz",
    "link-heading-missing:AGENTS#Section inexistante zz",
    "link-unresolved:Note qui n existe pas zz",
    "link-unresolved:Note qui n existe pas zz",
    "property-type-mismatch:création",
    "unknown-callout:calloutinventezz",
  ]);
  const mismatch = result.findings.find((finding) => finding.code === "property-type-mismatch")!;
  assert.deepEqual(
    { severity: mismatch.severity, line: mismatch.line, declaredType: mismatch.declaredType, location: mismatch.location },
    { severity: "error", line: 2, declaredType: "datetime", location: "frontmatter" },
  );
  assert.equal(result.findings.find((finding) => finding.location === "frontmatter" && finding.code === "link-unresolved")?.line, 3);
  assert.equal(result.findings.find((finding) => finding.code === "unknown-callout")?.line, 6);
  // Findings name keys and link text, never the property value.
  assert.doesNotMatch(JSON.stringify(result), /pas une date/u);
});

test("valid links, self-anchors and code spans produce no findings", async () => {
  const { inspector } = fixture({
    files: { "AGENTS.md": { cache: { headings: [{ heading: "Rules" }], blocks: { abc: {} } } }, "img.png": {} },
  });
  const content = [
    "# Local",
    "Line ^here",
    "## `config.json`",
    "## Using `foo`",
    "[[#config.json]] [[#Using foo]]",
    "[[AGENTS#Rules]] [[AGENTS#^abc|alias]] ![[img.png|200]] [[#Local]] [[#^here]]",
    "`[[Missing in code]]`",
    "```",
    "[[Missing in fence]]",
    "> [!fake]",
    "```",
    "%% [[Missing in comment]] %%",
  ].join("\n");
  const result = await inspector.inspect({ path: "Notes/Self.md", content, baseline: "current_file" });
  assert.deepEqual(result.findings, []);

  // An inline ```span``` at the start of a line opens no fence: later checks still run.
  const afterSpan = await inspector.inspect({ content: "```inline``` span\n[[Missing after span]]", baseline: "none" });
  assert.deepEqual(codes(afterSpan.findings), ["link-unresolved:Missing after span"]);
});

test("reports only what the candidate introduces compared with the current file", async () => {
  const current = "---\nstatus: maybe\n---\n[[Old missing]] [[AGENTS#Gone]]\n> [!legacy]\n";
  const { inspector } = fixture({
    files: { "Notes/Edit.md": { content: current }, "AGENTS.md": { cache: { headings: [] } } },
    types: { status: "checkbox" },
  });
  const candidate = `${current}[[Old missing]] [[New missing]]\n`;
  const result = await inspector.inspect({ path: "Notes/Edit.md", content: candidate, baseline: "current_file" });
  assert.equal(result.baseline, "current_file");
  // A second occurrence of a known problem is new too.
  assert.deepEqual(codes(result.findings), ["link-unresolved:Old missing", "link-unresolved:New missing"]);

  const unchanged = await inspector.inspect({ path: "Notes/Edit.md", content: current, baseline: "current_file" });
  assert.deepEqual(unchanged.findings, []);

  const changedValue = await inspector.inspect({
    path: "Notes/Edit.md",
    content: current.replace("status: maybe", "status: perhaps"),
    baseline: "current_file",
  });
  assert.deepEqual(codes(changedValue.findings), ["property-type-mismatch:status"]);

  const whole = await inspector.inspect({ path: "Notes/Edit.md", content: current, baseline: "none" });
  assert.deepEqual(codes(whole.findings).sort(), [
    "link-heading-missing:AGENTS#Gone",
    "link-unresolved:Old missing",
    "property-type-mismatch:status",
    "unknown-callout:legacy",
  ]);
});

test("callout types come from exact and partial data-callout selectors, nested and cached", async () => {
  const media = { cssRules: [{ selectorText: '.theme-dark .callout[data-callout="kanban-note"]' }] };
  const { inspector, setSheets } = fixture({
    sheets: [
      sheet('.callout[data-callout="recipe" i]', ".markdown-rendered", "[data-callout*='grid']", '[data-callout^="ad-"]', "[data-callout$=-box]"),
      { cssRules: [media as never] },
      { get cssRules(): never { throw new Error("SecurityError"); } },
    ],
  });
  const content = [
    "> [!recipe]", "> [!kanban-note]", "> [!photo-grid-3]", "> [!ad-warning]", "> [!quote-box]",
    "> [!NOTE]", "> > [!tip]", "> [!recipy]",
  ].join("\n");
  const result = await inspector.inspect({ content, baseline: "none" });
  assert.deepEqual(codes(result.findings), ["unknown-callout:recipy"]);
  assert.deepEqual(result.findings[0].suggestions, ["recipe"]);
  assert.equal(result.coverage.callouts.partialSelectors, true);

  // `|metadata` is not part of the type, and may contain spaces.
  const withMetadata = await inspector.inspect({ content: "> [!note|left] x\n> [!recipz|right clean] y", baseline: "none" });
  assert.deepEqual(codes(withMetadata.findings), ["unknown-callout:recipz"]);

  // The catalog is cached until Obsidian reports a CSS change.
  setSheets([]);
  assert.deepEqual(codes((await inspector.inspect({ content, baseline: "none" })).findings), ["unknown-callout:recipy"]);
  inspector.invalidateCallouts();
  const afterChange = await inspector.inspect({ content, baseline: "none" });
  assert.ok(codes(afterChange.findings).includes("unknown-callout:recipe"));
  assert.ok(!codes(afterChange.findings).includes("unknown-callout:tip"), "core types survive without stylesheets");
});

test("callout suggestions are capped and never expose the catalog", async () => {
  const many = Array.from({ length: 400 }, (_, index) => `[data-callout="note-${index}"]`);
  const { inspector } = fixture({ sheets: [sheet(...many)] });
  const result = await inspector.inspect({ content: "> [!note-x]", baseline: "none" });
  assert.equal(result.findings.length, 1);
  assert.ok(result.findings[0].suggestions!.length <= NOTE_INSPECT_MAX_SUGGESTIONS);
  assert.ok(JSON.stringify(result).length < 1000);
});

test("property values are checked against declared types, from the type manager or types.json", async () => {
  const content = [
    "---",
    "when: 2026-11-20",
    "at: 2026-11-20T09:30",
    "count: twelve",
    "done: yes",
    "rank: 3",
    "flag: true",
    "day: 2026-02-30",
    "aliases: 4",
    "free: anything",
    "empty: ",
    "---",
  ].join("\n");
  const types = {
    when: "date", at: "datetime", count: "number", done: "checkbox", rank: "number",
    flag: "checkbox", day: "date", aliases: "aliases", free: "text", empty: "number",
  };
  const live = fixture({ types });
  const fromManager = await live.inspector.inspect({ content, baseline: "none" });
  assert.equal(fromManager.coverage.properties.source, "metadataTypeManager");
  assert.deepEqual(codes(fromManager.findings), [
    "property-type-mismatch:count",
    "property-type-mismatch:done",
    "property-type-mismatch:day",
    "property-type-mismatch:aliases",
  ]);

  const fallback = fixture({ typesJson: JSON.stringify({ types: { COUNT: "number" } }) });
  const fromFile = await fallback.inspector.inspect({ content, baseline: "none" });
  assert.equal(fromFile.coverage.properties.source, "types.json");
  assert.deepEqual(fallback.reads, [".obsidian/types.json"]);
  assert.deepEqual(codes(fromFile.findings), ["property-type-mismatch:count"]);

  const none = await fixture().inspector.inspect({ content, baseline: "none" });
  assert.equal(none.coverage.properties.source, "unavailable");
  assert.deepEqual(none.findings, []);

  const date = new Date(Date.UTC(2026, 10, 20));
  for (const type of ["date", "datetime", "text"]) assert.equal(valueFitsType(type, date), true, type);
  for (const type of ["multitext", "tags", "aliases", "number", "checkbox"]) assert.equal(valueFitsType(type, date), false, type);
});

test("request contract: content required, path optional Markdown, baseline closed", () => {
  assert.deepEqual(parseNoteInspectRequest({ contractVersion: 1, content: "x" }), {
    contractVersion: 1, content: "x", baseline: "current_file",
  });
  assert.equal(parseNoteInspectRequest({ contractVersion: 1, content: "", path: "A/B.md", baseline: "none" }).path, "A/B.md");
  assert.throws(() => parseNoteInspectRequest({ contractVersion: 1 }));
  assert.throws(() => parseNoteInspectRequest({ contractVersion: 1, content: "x", path: "A/B.canvas" }));
  assert.throws(() => parseNoteInspectRequest({ contractVersion: 1, content: "x", path: "../B.md" }));
  assert.throws(() => parseNoteInspectRequest({ contractVersion: 1, content: "x", baseline: "other" }));
  assert.throws(() => parseNoteInspectRequest({ contractVersion: 1, content: "x", extra: true }));
});

test("notes/inspect route: strict 400, bounded 200 payload, content-free 500, advertised in status", async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./main.ts", import.meta.url))],
    bundle: true, format: "cjs", platform: "node", target: "node22", external: ["obsidian"], write: false, logLevel: "silent",
  });
  const obsidianStub = { Plugin: class {}, PluginSettingTab: class {}, Setting: class {}, TFile: class {}, parseYaml: () => ({}), stringifyYaml: () => "" };
  const loaded = { exports: {} as Record<string, unknown> };
  const nativeRequire = createRequire(import.meta.url);
  new Function("module", "exports", "require", bundle.outputFiles[0].text)(loaded, loaded.exports, (id: string) => id === "obsidian" ? obsidianStub : nativeRequire(id));
  const Bridge = loaded.exports.default as new () => any;
  const handlers = new Map<string, Function>();
  const api = { addRoute: (route: string) => { const r = { get: (h: Function) => { handlers.set("GET " + route, h); return r; }, post: (h: Function) => { handlers.set("POST " + route, h); return r; } }; return r; }, unregister: () => undefined };
  const bridge = new Bridge();
  bridge.register = () => undefined;
  bridge.manifest = { id: "obsidian-atomic-write-bridge", version: "test" };
  bridge.bindingFingerprint = "b".repeat(64);
  bridge.app = {
    workspace: { onLayoutReady: (callback: () => void) => callback() },
    plugins: { plugins: { "obsidian-local-rest-api": { getPublicApi: () => api } }, getPlugin: () => null },
    vault: { getAbstractFileByPath: () => null },
  };
  bridge.noteInspector = fixture({ files: {} }).inspector;
  await bridge.registerRestExtension();
  bridge.restLifecycle.probeNow();
  const invoke = async (method: string, route: string, body?: unknown) => {
    let code = 200; let payload: any;
    const res = { status(n: number) { code = n; return res; }, json(value: unknown) { payload = value; } };
    await handlers.get(`${method} /extensions/obsidian-atomic-write-bridge${route}`)!({ body }, res);
    return { code, payload };
  };

  assert.deepEqual((await invoke("GET", "/status")).payload.noteInspect, { contractVersion: 1, supported: true });
  assert.equal((await invoke("POST", "/notes/inspect", { contractVersion: 1, content: "x", path: "../x.md" })).code, 400);

  const ok = await invoke("POST", "/notes/inspect", { contractVersion: 1, content: "[[Nowhere]]", path: "A.md" });
  assert.equal(ok.code, 200);
  assert.equal(ok.payload.path, "A.md");
  assert.equal(ok.payload.bindingFingerprint, "b".repeat(64));
  assert.deepEqual(codes(ok.payload.findings), ["link-unresolved:Nowhere"]);

  bridge.noteInspector = { inspect: async () => { throw new Error("SECRET_PARSER_DETAIL"); } };
  const failed = await invoke("POST", "/notes/inspect", { contractVersion: 1, content: "x" });
  assert.equal(failed.code, 500);
  assert.doesNotMatch(JSON.stringify(failed.payload), /SECRET_PARSER_DETAIL/u);
});

test("callout suggestions run only for returned findings, once per type", async () => {
  // 375 theme types, as in the reference vault; suggestions scan them all.
  const theme = sheet(...Array.from({ length: 375 }, (_, index) => `[data-callout="theme-${index}"]`));
  let suggestionScans = 0;
  const suggest: typeof suggestCalloutTypes = (catalog, type) => {
    suggestionScans += 1;
    return suggestCalloutTypes(catalog, type);
  };
  const repeated = Array.from({ length: 500 }, () => "> [!themezz]").join("\n");
  const { inspector } = fixture({ files: { "Notes/Big.md": { content: repeated } }, sheets: [theme], suggest });

  const unchanged = await inspector.inspect({ path: "Notes/Big.md", content: repeated, baseline: "current_file" });
  assert.deepEqual(unchanged.findings, []);
  assert.equal(suggestionScans, 0, "known (baseline) callouts must not be scanned");

  const doubled = await inspector.inspect({ path: "Notes/Big.md", content: `${repeated}\n${repeated}`, baseline: "current_file" });
  assert.equal(doubled.findings.length, NOTE_INSPECT_MAX_FINDINGS);
  assert.equal(doubled.coverage.findings.total, 500);
  assert.equal(suggestionScans, 1, "one scan per type per inspection");
  assert.deepEqual(doubled.findings[0].suggestions, doubled.findings[99].suggestions);

  suggestionScans = 0;
  const distinct = Array.from({ length: 150 }, (_, index) => `> [!zz-${index}]`).join("\n");
  const capped = await inspector.inspect({ content: distinct, baseline: "none" });
  assert.equal(capped.findings.length, NOTE_INSPECT_MAX_FINDINGS);
  assert.equal(suggestionScans, NOTE_INSPECT_MAX_FINDINGS, "no scan for findings beyond the cap");
});
