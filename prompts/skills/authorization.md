---
name: authorization
description: Authorization and tenant isolation — missing checks, IDOR, privilege escalation, data leaking across tenants.
---
For every endpoint, handler, job or query the change adds or modifies:

- Who may call it, and where is that enforced? Check the check exists on this path, not only in
  the UI or on a sibling route. New routes copied from an old one often lose its guard.
- Object-level access (IDOR): an id taken from the request (path, body, query) is used to load or
  modify a record without checking the caller owns it or belongs to its tenant.
- Tenant isolation: queries that filter by id but not by tenant; caches, queues, file paths or
  object-store keys shared across tenants; background jobs that run with elevated rights and act
  on caller-supplied ids.
- Privilege escalation: role or permission fields writable through mass assignment; admin-only
  flags accepted from ordinary users; checks that compare the wrong field.
- Fail-open defaults: missing config, an exception or an unknown role treated as allowed.
- Secrets and personal data returned in responses, logs, error messages or events that more people
  can read than should.

A finding names the caller that should be refused, the request it sends, and what it gets.
