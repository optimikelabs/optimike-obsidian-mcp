# Assets

The public documentation uses a generated editorial SVG system under
`readme/`. Every visual has English and French variants with the same
composition and editable text.

Generate and verify the complete set:

```bash
npm run visuals:generate
npm run test:visuals
```

The generator is `scripts/generate-readme-visuals.mjs`. The exact file set,
dimensions, palette and font fallbacks are recorded in
`readme/manifest.json`.

The assets follow the Optimike “Paper + Atlas + Workbench” direction:

- paper, ink, muted blue, copper and green roles;
- serif editorial headings, sans-serif explanations and monospace metadata;
- no external fonts, raster payloads, scripts, base64 data or remote
  dependencies;
- technical claims expressed as maintainable SVG text rather than generated
  imagery.

`npm run test:docs` also runs the visual contract and verifies every relative
Markdown image reference.
