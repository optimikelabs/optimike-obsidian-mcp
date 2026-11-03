# Frontmatter contract v1

All three validators exercise the byte-identical `frontmatter-contract.json` corpus.
The Python helper is byte-identical in Builder and the standalone tools.

- Delimiters occupy their entire lines; LF, CRLF and closing at EOF are supported.
- Free Markdown can omit frontmatter; SKILL.md must contain it.
- Opened-but-unclosed blocks and delimiters with trailing text are errors.
- Root must be a mapping, including `{}`. Empty/comment-only blocks and explicit null are rejected.
- Explicit duplicate keys, including nested keys, are rejected. YAML merge overrides remain valid.
- BOM before the opening delimiter is explicitly unsupported, never silently absent.
- `---` inside quoted or indented scalar values is valid.
- Parser diagnostics never echo YAML excerpts; no source content is rewritten.
- Patch compilation remains a separate conservative contract; a valid mapping does not imply patch support.

Run Builder `python -m pytest builder/tests`; MCP `npm run test:frontmatter-format`;
the standalone tool `python -m pytest tests/test_frontmatter_contract.py` in its own repository.
