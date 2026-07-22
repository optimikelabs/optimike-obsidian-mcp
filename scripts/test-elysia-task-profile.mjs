import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { load as parseYaml } from "js-yaml";

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
  { name: "folder filter without current-folder scope", mutate: value => { delete value.filters[4].scope; } },
  { name: "non-folder filter with folder scope", mutate: value => { value.filters[0].scope = "current-folder"; } },
];

for (const testCase of rejectedProfiles) {
  const candidate = structuredClone(profile);
  testCase.mutate(candidate);
  assert.equal(validate(candidate), false, `${testCase.name} should be rejected`);
}

const skillUrl = new URL(
  "../profiles/elysia-tasks/skills/elysia-task-gouverneur/SKILL.md",
  import.meta.url,
);
const skill = await readFile(skillUrl, "utf8");
const frontmatterMatch = skill.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
assert.ok(frontmatterMatch, "public task skill must have YAML frontmatter");
const frontmatter = parseYaml(frontmatterMatch[1]);

assert.equal(frontmatter.name, "elysia-task-gouverneur");
assert.equal(frontmatter.metadata.version, "1.0.0");
assert.equal(frontmatter.metadata.skill_structure, "graph");
assert.equal(frontmatter.metadata.portability_class, "profile-bound-portable");
assert.equal(frontmatter.metadata.profile_id, profile.profileId);
assert.equal(frontmatter.metadata.profile_schema_version, profile.schemaVersion);
assert.equal(frontmatter.metadata.reference_gate, true);

const requiredSkillTokens = [
  "operon_get_configuration",
  "operon_status",
  "expectedRevision",
  "idempotencyKey",
  "references_ouvertes",
  "module_route",
  "etape_pipeline_en_cours",
  "sortie_finale_autorisee",
  "apply_propose: aucun",
  "Lire seulement `SKILL.md` ne compte pas comme usage complet",
];
for (const token of requiredSkillTokens) {
  assert.ok(skill.includes(token), `public task skill is missing ${token}`);
}

const markdownLinks = [...skill.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);
const referenceLinks = markdownLinks.filter(link => link.startsWith("references/"));
assert.equal(new Set(referenceLinks).size, 6, "public task skill must expose six graph modules");
for (const link of markdownLinks) {
  await readFile(new URL(link, skillUrl), "utf8");
}

const publicSkillFiles = [
  skill,
  ...await Promise.all(
    [...new Set(referenceLinks)].map(link => readFile(new URL(link, skillUrl), "utf8")),
  ),
];
const publicSkillCorpus = publicSkillFiles.join("\n");
const forbiddenPrivateMarkers = [
  /\b[A-Z]:\\/,
  /\/Users\//,
  /\/home\//,
  /\.agents[\\/]/,
  /\bMike\b/,
  /Micka[eë]l/,
  /Efforts\/Domaines/,
  /SOP — Gouvernance Tasks/,
  /Standard — Usage Tasks/,
];
for (const marker of forbiddenPrivateMarkers) {
  assert.equal(marker.test(publicSkillCorpus), false, `private marker leaked: ${marker}`);
}

console.log(
  `ÉLYSIA task profile and public skill tests passed: ${rejectedProfiles.length + 1} profile assertions, 6 skill modules`,
);
