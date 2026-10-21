Verify the candidate finding below. Read the relevant code, then call `submit_assessment`
with your independent conclusion, change relation, severity, confirmation level, and effort.

If — and only if — the fix is local, mechanical and unambiguous (a wrong comparison, a
missing guard or null check, an off-by-one bound, a misspelled identifier), also fill
`suggestion` so the author can commit it in one click:

- `startLine`/`endLine` — the head-side range you are replacing. It must contain the line
  the finding is anchored to, and must stay inside the lines this pull request changed.
- `originalText` — the current content of that exact range, copied verbatim from the file.
  It is checked character by character before publishing; if it does not match, the whole
  suggestion is discarded (the finding is still reported).
- `replacement` — the full replacement for that range. Must not contain triple backticks.

Leave `suggestion` out whenever the fix needs judgement, spans more than a few lines,
touches other files, or you are not certain it is correct. A wrong suggestion is worse
than none: the author commits it with one click. Reporting the problem is always enough.
