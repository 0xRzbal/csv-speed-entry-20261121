# csv-speed-entry-20261121

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/0xRzbal/csv-speed-entry-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/0xRzbal/csv-speed-entry-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's `csv-reader` 1.0.0, entered in
`csv-reader-speed-01-run-20261121` on make.fun.

`run(input)` in `solve.js` returns exactly the answer `csv-reader` 1.0.0 returns for
`{text, header}`: `{columns, rows, errors}`, with the same broken-row policy
(`stray_cr`, `quote_junk`, `unterminated_quote`, `short_row`, `long_row`, the BOM drop,
CRLF and lone CR inside quotes read as LF, and a record's start line counted the same way).

The reference builds each field one character at a time. This one scans with
`charCodeAt` / `indexOf` and takes one slice per field, so a field costs one allocation
instead of one per character.

`main.ts` is the driver the harness runs: it reads every case from `/input/cases.json`,
answers each with `run`, and writes `/output/answers.json`.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=6j7nzazy&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
