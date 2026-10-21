---
name: text-processing
description: Splitting, joining, measuring and slicing text — whitespace, Unicode, line and offset bookkeeping.
---
Check each of these against the changed code and the code it calls.

- Split and rejoin round-trip: does joining the pieces give back the original text? Separators,
  whitespace between sentences, blank lines inside code or quotes, trailing newlines — look for
  what `split`, `trim`, `filter(Boolean)` or a regex drops and nothing puts back.
- Measuring: character count vs. bytes vs. UTF-16 code units vs. display width vs. estimated
  tokens. CJK, emoji and combining characters change the ratio; slicing at a fixed width can
  exceed a budget or cut a surrogate pair or grapheme in half.
- Line and offset bookkeeping: 0- vs 1-based, inclusive vs exclusive ends, CRLF, positions that
  drift after the text is modified, ranges recomputed from the wrong base.
- Derived metadata (locators, headings, counts, ids) that must stay consistent with the text it
  describes: after splitting, merging or concatenating pieces, does every piece's metadata still
  describe exactly that piece's text?
- Empty input, input that is only whitespace or only separators, and a single item larger than
  the limit.

Report only with a concrete input: which text produces which wrong output.
