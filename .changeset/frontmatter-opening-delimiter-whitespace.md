---
'@modelcontextprotocol/core-internal': patch
---

`splitFrontmatter()` now accepts trailing spaces or tabs on the opening `---` line, matching the closing delimiter's existing tolerance and YAML's document-start marker. A `SKILL.md` whose first line is `--- ` or `---\t` is valid YAML but previously failed with `SKILL.md must begin with a "---" line`.
