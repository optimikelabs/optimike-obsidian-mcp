import assert from "node:assert/strict";
import test from "node:test";
import { createFunctionRegistry, extractFunctionRegistry } from "./function-registry.mjs";

// Synthetic bundle shaped like Obsidian's minified app.js. Identifiers differ
// from the 1.15.1 build on purpose: nothing minified may be hardcoded.
const PRELUDE = [
  "var Zt=class{static toString(){return this.type}};Zt.type=\"Any\";",
  "var Hb=class extends Zt{};",
  "var Qs=class extends Hb{};Qs.type=\"String\";",
  "var Qn=class extends Hb{};Qn.type=\"Number\";",
  "var Qb=class extends Hb{};Qb.type=\"Boolean\";",
  "var Lz=class extends Hb{};Lz.type=\"List\";var Ql=Lz;",
  "var Qr=class extends Hb{};Qr.type=\"RegExp\";",
  "var Tr=w.formulas.funcs;",
  "function pA(o,...t){return{name:o,type:t}}",
  "function pB(o,...t){return{name:o,type:t,optional:!0}}",
  "function pC(o,...t){return[{name:o,type:t,variadic:!0}]}",
  "function pD(o,t,...e){return{name:o,type:e,customWidget:t}}",
  "var Fn=class{constructor(){this.ctx=null}};",
  "var Ux=class extends Fn{constructor(){super(...arguments);this.params=[pA(\"self\",Qn)]}};",
].join("");

function globalFn(receiver, name, params, doc) {
  return `${receiver}.addGlobal(new class extends Fn{constructor(){super(...arguments);this.name="${name}";this.params=[${params}];this.docString=Tr.${doc}}apply(){return null}});`;
}

function instanceFn(receiver, type, name, params, doc, parent = "Fn") {
  const paramsPart = params === null ? "" : `this.params=[${params}];`;
  const docPart = doc ? `this.docString=Tr.${doc}` : "";
  return `${receiver}.addForType(${type},new class extends ${parent}{constructor(){super(...arguments);this.name="${name}";${paramsPart}${docPart}}apply(t){return t}});`;
}

function syntheticBundle({ receiver = "Kq", fillers = 60, globals = ["if", "now", "link"], extra = "" } = {}) {
  const parts = [PRELUDE, `var ${receiver}=new class{addGlobal(t){}addForType(t,e){}};`];
  const docs = { if: "labelGlobalIf", now: "labelGlobalNow", link: "labelGlobalLink" };
  for (const name of globals) {
    const params =
      name === "if"
        ? 'pA("condition",Qb),pA("true_result",Zt),pB("false_result",Zt)'
        : name === "link"
          ? 'pA("self",Qs),pB("display",Zt)'
          : "";
    parts.push(globalFn(receiver, name, params, docs[name]));
  }
  parts.push(globalFn(receiver, "max", '...pC("inputs",Qn)', "labelGlobalMax"));
  parts.push(instanceFn(receiver, "Qn", "round", 'pA("self",Qn),pB("digits",Qn)', "labelNumberRound"));
  parts.push(instanceFn(receiver, "Qn", "abs", null, "labelNumberAbs", "Ux"));
  parts.push(instanceFn(receiver, "Ql", "contains", 'pA("self",Ql),pD("value","text",Zt)', "labelListContains"));
  parts.push(instanceFn(receiver, "Qr", "matches", 'pA("self",Qr),pA("value",Qs)', "labelRegExpMatches"));
  parts.push(instanceFn(receiver, "Zt", "isTruthy", 'pA("self",Zt)', "labelValueIsTruthy"));
  parts.push(instanceFn(receiver, "Qs", "reverse", 'pA("self",Qs)', null));
  for (let i = 0; i < fillers; i++) {
    parts.push(instanceFn(receiver, "Qs", `filler${i}`, 'pA("self",Qs),pA("flag",Hb)', "labelStringFiller"));
  }
  parts.push(extra);
  return parts.join("");
}

const translate = (key) =>
  ({
    "formulas.funcs.label-number-round": "Rounds the number to the nearest integer.",
    "formulas.funcs.label-reg-exp-matches": "Returns whether the value matches.",
  })[key] ?? key;

const byName = (functions, name, on) =>
  functions.find((fn) => fn.name === name && (!on || fn.on === on));

test("extracts typed functions without hardcoded minified identifiers", () => {
  const { functions, warnings } = extractFunctionRegistry(syntheticBundle(), translate);

  assert.deepEqual(warnings, []);
  assert.deepEqual(byName(functions, "round"), {
    name: "round",
    on: "Number",
    params: [{ name: "digits", types: ["Number"], optional: true, variadic: false }],
    doc: "Rounds the number to the nearest integer.",
  });
  // Globals keep their first parameter; instance functions drop "self".
  assert.deepEqual(byName(functions, "link").params.map((param) => param.name), ["self", "display"]);
  assert.deepEqual(byName(functions, "if").params[0].types, ["Boolean"]);
  assert.deepEqual(byName(functions, "max").params, [
    { name: "inputs", types: ["Number"], optional: false, variadic: true },
  ]);
  // Parameters inherited from a shared base class.
  assert.deepEqual(byName(functions, "abs").params, []);
  assert.equal(byName(functions, "abs").on, "Number");
  // Custom-widget helper, aliased type id, RegExp and Value doc keys.
  assert.deepEqual(byName(functions, "contains"), {
    name: "contains",
    on: "List",
    params: [{ name: "value", types: ["Any"], optional: false, variadic: false }],
    doc: null,
  });
  assert.equal(byName(functions, "matches").on, "RegExp");
  assert.equal(byName(functions, "matches").doc, "Returns whether the value matches.");
  assert.equal(byName(functions, "isTruthy").on, "Any");
  // Abstract class resolved through its parent.
  assert.deepEqual(byName(functions, "filler0").params[0].types, ["Any"]);
  assert.equal(byName(functions, "reverse").doc, null);
});

test("the guard refuses an incomplete or ambiguous registry", () => {
  const refusals = [
    syntheticBundle({ fillers: 40 }),
    syntheticBundle({ globals: ["if", "now"] }),
    syntheticBundle({ extra: globalFn("Other", "stray", "", "labelGlobalStray") }),
  ];
  for (const bundle of refusals) {
    assert.throws(() => extractFunctionRegistry(bundle, translate), { reason: "canary_failed" });
  }
});

test("fetches the bundle once per Obsidian version and filters by type", async () => {
  let fetches = 0;
  const deps = {
    obsidianVersion: "1.15.1",
    fetchBundle: async () => {
      fetches++;
      return syntheticBundle();
    },
    translate,
  };
  const list = createFunctionRegistry(deps);

  const numbers = await list("number");
  assert.equal(numbers.available, true);
  assert.equal(numbers.source, "obsidian-app-bundle");
  assert.equal(numbers.obsidianVersion, "1.15.1");
  assert.deepEqual(numbers.functions.map((fn) => fn.name).sort(), ["abs", "round"]);
  assert.ok((await list()).functions.length > 60);
  assert.equal(fetches, 1);

  deps.obsidianVersion = "1.15.2";
  await list();
  assert.equal(fetches, 2);
});

test("reports an unavailable registry instead of a partial list", async () => {
  const list = createFunctionRegistry({
    obsidianVersion: "1.15.1",
    fetchBundle: async () => syntheticBundle({ fillers: 10 }),
    translate,
  });
  assert.deepEqual(await list(), { available: false, reason: "canary_failed", functions: [] });

  const offline = createFunctionRegistry({
    obsidianVersion: "1.15.1",
    fetchBundle: async () => {
      throw new Error("offline");
    },
    translate,
  });
  assert.deepEqual(await offline(), { available: false, reason: "engine_unavailable", functions: [] });
});
