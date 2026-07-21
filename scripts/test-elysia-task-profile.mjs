import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";

const profileUrl = new URL("../profiles/elysia-tasks/v1/profile.json", import.meta.url);
const schemaUrl = new URL("../profiles/elysia-tasks/v1/schema.json", import.meta.url);
const profile = JSON.parse(await readFile(profileUrl, "utf8"));
const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

assert.equal(validate(profile), true, JSON.stringify(validate.errors));

const rejectedProfiles = [
  { name: "empty filter catalog", mutate: value => { value.filters = []; } },
  { name: "missing canonical filter", mutate: value => { value.filters.pop(); } },
  { name: "duplicate canonical filter id", mutate: value => { value.filters[4].id = value.filters[0].id; } },
  { name: "filter without conditions", mutate: value => { value.filters[0].all = []; } },
  { name: "condition without field or operator", mutate: value => { value.filters[0].all[0] = {}; } },
];

for (const testCase of rejectedProfiles) {
  const candidate = structuredClone(profile);
  testCase.mutate(candidate);
  assert.equal(validate(candidate), false, `${testCase.name} should be rejected`);
}

console.log(`ÉLYSIA task profile schema tests passed: ${rejectedProfiles.length + 1} assertions`);
