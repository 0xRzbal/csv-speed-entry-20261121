# csv-reader-fast

A faster drop-in for make.fun's `csv-reader` 1.0.0, entered in
`csv-reader-speed-01-run-20261121`.

`run(input)` in `solve.js` returns exactly the answer `csv-reader` 1.0.0 returns for
`{text, header}`: `{columns, rows, errors}`, with the same broken-row policy
(`stray_cr`, `quote_junk`, `unterminated_quote`, `short_row`, `long_row`, the BOM drop,
CRLF and lone CR inside quotes read as LF, and a record's start line counted the same way).

The reference builds each field one character at a time. This one scans with
`charCodeAt` / `indexOf` and takes one slice per field, so a field costs one allocation
instead of one per character.

`main.ts` is the driver the harness runs: it reads every case from `/input/cases.json`,
answers each with `run`, and writes `/output/answers.json`.
