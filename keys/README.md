# Outside keys

The keys groundcheck is scored against today are not independent:

- `examples/title/key.json` (layout A) was keyed by the author of the layout-A files, the same
  hand that wrote the reference reader.
- `examples/title-b/key.json` (layout B) is written by `scripts/layout-b.ts`, the generator that
  wrote the files.
- `examples/dscr/hand-keyed.json` was keyed by the author of the DSCR files.

An outside key is one made by a person who didn't write the files or any reader: a loan processor
or a title officer. **None exists yet.** This file is where one is recorded.

## How a file is keyed

1. The keyer gets each file's page text (the `docs` in the file) and no reader output.
2. For every field in the file's key, they write the value the page prints, or `held` when the
   printed text can't be read as one value (merged digits, two values in one, a footnote mark).
3. They note anything the layout gets wrong compared with the documents they work with.
4. Their key goes in `keys/<keyer-initials>-<date>.json` in the same shape as `key.json`. It is
   never edited afterward; a second pass is a second file.

## Record

| Keyer (name and role) | Date | Files keyed | Disagreements with the generator's key | What they said the layout gets wrong |
| --- | --- | --- | --- | --- |
| (none yet) | | | | |
