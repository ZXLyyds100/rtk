# RTK #3920 — real local CLI evidence

Original: `e542dca0bdcc262fa035dcf7fc33910cdcc8cdaf` (`develop`).
The exact feature-source hashes and commands are in `validation.json`.

Ruff 0.16.6 and SQLFluff 4.3.0 were installed in an isolated virtual environment.
Both binaries ran the same checked-in fixture inputs with isolated configuration,
history and cache directories. No linter output was mocked.

From `fixture/`:

```sh
sqlfluff lint --ignore-local-config --config .sqlfluff models
rtk sqlfluff lint --ignore-local-config --config .sqlfluff models
ruff check --isolated --select F401,E701 src
rtk ruff check --isolated --select F401,E701 src
```

`before-runtime.json` and `after-runtime.json` include native text, actual injected
JSON, direct invocation, lint dispatch and pipe outputs, exit codes and semantic
diagnostics. Only local machine prefixes are normalized in the public records.
SQLFluff timing fields vary between real runs; diagnostic equivalence, not
byte-identical JSON, is asserted.

| Four-file corpus | Native text | Original RTK | Patched RTK |
|---|---:|---:|---:|
| SQLFluff, 18 violations | 1,863 B | 2,008 B | 1,396 B |
| Ruff, 12 violations | 1,986 B | 1,047 B | 694 B |

These are fixture-specific output bytes, not tokenizer counts, model-request
sizes or API bills.

The four screenshots and 12.88-second recording show a **viewer of the actual
captured process output**, not product UI and not a live service. The viewport
is 1440×1200 throughout; video was decoded and sought at four positions.
Run `node replay.mjs` to inspect the captures interactively.

`extended-validation.json` records six clean/fatal/explicit-format controls and
actual SQLite recovery: all 180 diagnostic messages from a 60-file Ruff run and
all 51 files from a large direct SQLFluff run. The existing SQLFluff *pipe*
entry point has no separate recovery hint; this patch does not claim to add it.
Existing 100-character message truncation and 50-detail caps are unchanged.

`performance.json` contains 40 interleaved release-process launches per variant
and filter after five warmups. Both executable hashes and their expected
original/patched outputs were checked. Timings include process launch, CLI,
filtering and output capture; they are not isolated filter microbenchmarks or
cross-platform hook-startup guarantees.
