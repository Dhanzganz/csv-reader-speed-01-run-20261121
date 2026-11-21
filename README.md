# csv-reader-speed-01 — fast drop-in for csv-reader 1.0.0

[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Dhanzganz/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Dhanzganz/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

Built for the [$100 bounty on make.fun](https://make.fun/bounty/csv-reader-speed-01-run-20261121): read broken CSV files faster.

## What it is

`solve.js` is a from-scratch, dependency-free re-implementation of make.fun's
csv-reader 1.0.0 with exactly the same answers on every case — BOM, CRLF/LF,
stray CR, quoted fields with `""` escapes, `quote_junk`, unterminated quotes,
short/long row padding and cutting, and the `{code, line, row}` error ordering —
but structured for speed instead of the reference's character-by-character
concatenation. `main.ts` is the house driver that answers every case with it.

## How it is fast

- **Clean-line fast path** — a physical line with no `"` and no stray CR is
  parsed with one `slice` + `split(',')`.
- **Dirty lines** — field-at-a-time scanning driven by native `indexOf`;
  quoted fields are found by `indexOf('"')` with `""` pairs skipped in the
  scan, content sliced (never built character by character).
- **Zero per-field allocations** — field readers share result slots; no regex,
  no per-character loop on the hot path.

## Measured speed (local, Node 24, solve-only CPU per 6-case set)

| Set | csv-reader 1.0.0 | This entry | Speedup |
| --- | --- | --- | --- |
| Practice (kit) | ~760–844 ms | ~101–135 ms | ~6–7× |
| Fresh seed A | 273 ms | 125 ms | 2.2× |
| Fresh seed B | 446 ms | 129 ms | 3.5× |
| Fresh seed C | 344 ms | 135 ms | 2.5× |

Correctness: the kit scorer passes 6/6 on the practice set, and a differential
fuzz against the reference matches on 4,262/4,262 random and targeted nasty
inputs. Two runs of `main.ts` produce byte-identical `answers.json`.

## Files

- `solve.js` — the fast drop-in (ES module, `run(input)` returns
  `{columns, rows, errors}` exactly as csv-reader 1.0.0 does).
- `main.ts` — the house driver: reads `/input/cases.json`, answers every case
  with `run`, writes `/output/answers.json`.
- `LICENSE` — MIT.

## License

MIT — see `LICENSE`.
