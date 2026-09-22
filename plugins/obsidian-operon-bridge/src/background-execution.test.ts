import assert from "node:assert/strict";
import test from "node:test";
import { acquireBackgroundExecution } from "./background-execution";
function fixture(initial = true) {
  let policy = initial; let destroyed = false;
  const writes: boolean[] = [];
  const contents = { getBackgroundThrottling() { return policy; }, setBackgroundThrottling(value: boolean) { policy = value; writes.push(value); }, isDestroyed() { return destroyed; } };
  return { contents, writes, destroy: () => { destroyed = true; }, remote: { getCurrentWebContents: () => contents } };
}
test("mounted Desktop bridge resumes hidden renderer and restores prior policy exactly once", () => {
  const f = fixture(); const release = acquireBackgroundExecution(true, () => ({ remote: f.remote }));
  assert.ok(release); assert.equal(f.contents.getBackgroundThrottling(), false);
  release(); release(); assert.deepEqual(f.writes, [false, true]);
});
test("preserves an already unthrottled renderer", () => {
  const f = fixture(false); acquireBackgroundExecution(true, () => ({ remote: f.remote }))!();
  assert.deepEqual(f.writes, []);
});
test("modern Electron remote module fallback is loaded only on Desktop", () => {
  const f = fixture(); const names: string[] = [];
  const release = acquireBackgroundExecution(true, name => { names.push(name); return name === "electron" ? {} : f.remote; });
  assert.deepEqual(names, ["electron", "@electron/remote"]); release!();
  acquireBackgroundExecution(false, () => { throw new Error("must not load on mobile"); })!();
});
test("unavailable Electron is reported without disrupting routes", () => {
  assert.equal(acquireBackgroundExecution(true, () => { throw new Error("unavailable"); }), null);
  assert.equal(acquireBackgroundExecution(true, () => ({ remote: {} })), null);
});
test("window destruction makes release harmless", () => {
  const f = fixture(); const release = acquireBackgroundExecution(true, () => ({ remote: f.remote }));
  f.destroy(); release!(); assert.deepEqual(f.writes, [false]);
});
test("failed policy application attempts to restore previous state", () => {
  const f = fixture(); const original = f.contents.setBackgroundThrottling;
  f.contents.setBackgroundThrottling = function(value) { original.call(this, value); if (!value) throw new Error("failure"); };
  assert.equal(acquireBackgroundExecution(true, () => ({ remote: f.remote })), null);
  assert.deepEqual(f.writes, [false, true]);
});
