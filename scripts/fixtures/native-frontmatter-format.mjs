import { parse, stringify } from "yaml";

// Reproduction of the options observed in Obsidian 1.15; not the embedded library.
export function nativeFormatFixture(binding) {
  const fingerprint = () => typeof binding === "function" ? binding() : binding;
  return {
    async status() { return { frontmatterFormat: { contractVersion: 1, supported: true }, backend: { bindingFingerprint: fingerprint() } }; },
    async inspectFrontmatterFormat(yaml) { return { ok: true, contractVersion: 1, bindingFingerprint: fingerprint(), warnings: [],
      canonicalYaml: stringify(parse(yaml), null, { nullStr: "", lineWidth: 0, aliasDuplicateObjects: false }) }; },
  };
}
