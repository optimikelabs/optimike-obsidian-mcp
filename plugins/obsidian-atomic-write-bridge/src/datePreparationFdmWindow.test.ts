import assert from "node:assert/strict";
import test from "node:test";
import { createDatePreparation, DatePreparationDeferred } from "./datePreparation.js";
import { sha256 } from "./contract.js";

/**
 * Simulated FDM 1.6.0 pipeline, reduced to what the source shows
 * (setupCreateHandler/armNewFileWindow, the modify handler during the window,
 * onNewFileWindowExpired and the manual command), on one shared clock.
 */
function fixture(windowMs = 20_000) {
  let clock = 0;
  let commands = 0;
  const timers: Array<{ at: number; run: () => void }> = [];
  const file = { path: "Nouvelle.md", extension: "md" };
  let content = "---\nstatut: actif\n---\ncorps\n";
  const stamp = () => `2026-10-27T10:${String(Math.floor(clock / 60_000)).padStart(2, "0")}:${String(Math.floor(clock / 1000) % 60).padStart(2, "0")}`;
  const fdm: any = {
    settings: { enableAutoUpdate: true, enableCreateTime: true, headerCreated: "création", headerUpdated: "modification", dateFormat: "yyyy-MM-dd'T'HH:mm:ss" },
    recentlyCreated: new Set<string>(), newFileTimers: new Map<string, unknown>(), newFileModified: new Set<string>(),
    modifyTimers: new Map<string, unknown>(), manualPending: new Set<string>(), processingFiles: new Set<string>(),
  };
  const write = (next: string) => {
    content = next;
    // FDM's modify handler: inside the new-file window the pass is remembered for later.
    if (fdm.recentlyCreated.has(file.path)) fdm.newFileModified.add(file.path);
  };
  const date = () => {
    const created = /création:/u.test(content) ? content : content.replace("statut: actif", `statut: actif\ncréation: ${stamp()}`);
    write(/modification:/u.test(created) ? created.replace(/modification: .*/u, `modification: ${stamp()}`) : created.replace("statut: actif", `statut: actif\nmodification: ${stamp()}`));
  };
  // vault "create" event -> armNewFileWindow
  fdm.recentlyCreated.add(file.path);
  fdm.newFileTimers.set(file.path, {});
  timers.push({ at: windowMs, run: () => {
    fdm.newFileTimers.delete(file.path);
    fdm.recentlyCreated.delete(file.path);
    if (fdm.newFileModified.delete(file.path)) date();
  } });
  const advance = (ms: number) => {
    clock += ms;
    for (const timer of timers.splice(0).sort((a, b) => a.at - b.at)) {
      if (timer.at <= clock) timer.run(); else timers.push(timer);
    }
  };
  const app: any = {
    vault: { getAbstractFileByPath: () => file, read: async () => content },
    plugins: { getPlugin: (id: string) => id === "frontmatter-date-manager" ? fdm : undefined },
    workspace: { activeLeaf: null, getLeaf: () => ({ openFile: async () => undefined, detach() {} }), getActiveFile: () => file,
      setActiveLeaf(value: any) { this.activeLeaf = value; } },
    commands: { commands: { "frontmatter-date-manager:update-timestamps-current-file": {} }, executeCommandById() { commands++; date(); return true; } },
  };
  const parse = (yaml: string) => Object.fromEntries(yaml.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
  const prepare = createDatePreparation(app, parse, { enabled: () => true, now: () => clock, sleep: async (ms) => advance(ms), timeoutMs: 55_000 });
  return { fdm, prepare, advance, content: () => content, request: () => ({ path: file.path, expectedSha256: sha256(content) }),
    schedule: (delay: number, run: () => void) => { timers.push({ at: clock + delay, run }); }, dateNow: () => date(), commands: () => commands };
}

test("a note still in FDM's new-file window is not dated twice: preparation waits for the window", async () => {
  const f = fixture();
  const prepared = await f.prepare(f.request());
  assert.equal(prepared.datePreparation?.kind, "date-manager-before-plan");
  // FDM's own deferred pass would rewrite the note after the preparation returned
  // (the race observed by lot E): nothing may change once the preparation is sealed.
  f.advance(60_000);
  assert.equal(f.content(), prepared.content, "FDM's new-file pass rewrote the note after the preparation returned");
});

test("pending FDM work beyond the request budget is refused before any effect", async () => {
  const f = fixture(120_000);
  const before = f.content();
  await assert.rejects(f.prepare(f.request()), (error) => error instanceof DatePreparationDeferred);
  assert.equal(f.content(), before);
  assert.equal(f.commands(), 0, "no command ran inside the window");
});

test("a pending FDM pass that changes the note during the wait is a conflict before any effect", async () => {
  const f = fixture(0);
  f.advance(1);
  const request = f.request();
  f.fdm.modifyTimers.set("Nouvelle.md", {});
  f.schedule(2_000, () => { f.fdm.modifyTimers.delete("Nouvelle.md"); f.dateNow(); });
  const run = f.prepare(request);
  await assert.rejects(run, (error: any) => error?.constructor?.name === "HashConflictError");
  assert.equal(f.commands(), 0);
  assert.match(f.content(), /création:/u, "only FDM's own pass dated the note");
});
