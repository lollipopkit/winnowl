---
name: injection
description: Injection and unsafe input — SQL, shell, path traversal, SSRF, deserialization, template and regex injection.
---
Trace untrusted input (request data, file contents, environment set by users, repository content,
webhook payloads) to sensitive sinks:

- SQL / NoSQL: strings concatenated or interpolated into queries; identifiers (column, table,
  sort field) taken from input without an allowlist.
- Shell: input reaching `exec`, `system`, backticks or a shell with `shell: true`; arguments that
  can start with `-` and become options.
- Paths: input joined into file paths without normalising and checking the result stays inside the
  intended directory (`..`, absolute paths, symlinks, zip entries).
- SSRF: user-controlled URLs fetched by the server, including redirects and DNS names resolving to
  internal or metadata addresses.
- Deserialization of untrusted data into objects with behaviour (pickle, YAML full loaders, Java
  serialization, `eval`, `Function`).
- Templates and HTML: user input rendered without escaping; `innerHTML`, `dangerouslySetInnerHTML`,
  `v-html`; markdown rendered with raw HTML enabled.
- Regular expressions built from input, or patterns with catastrophic backtracking on input.

A finding names the input, the path it takes, and what an attacker makes the sink do.
