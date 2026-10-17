# RTK #4543: native Semgrep before/after evidence

Baseline: `e542dca0bdcc262fa035dcf7fc33910cdcc8cdaf`.
Fixed code: `7195001933db08a90f3720df48818d4a2ce64e8d`.

Actual Semgrep 1.181.0 runs with the repository's unchanged `.semgrep.yml`,
on isolated synthetic Git PR merge histories. This is not a GitHub-hosted CI run
or a replay of the historical #3613 runner.

Eight combinations cover before/after × inherited-only/new-PR finding ×
ERROR/WARNING. The original workflow wrongly reports the base-only finding.
The fixed baseline excludes it but still reports a new PR finding; the ERROR
gate still exits 1, and warnings remain advisory.

The historical filesystem-deletion example is WARNING in the current rules.
The ERROR scenario therefore uses the existing interpreter-execution rule;
the WARNING scenario separately exercises filesystem-deletion.

- Screenshots and video capture actual native scan executions.
- `scanner-comparison.json` pins commands, commits, findings and exit codes.
- `actual-branch-scan.json` records both native scans of the real fixed branch.
- Media stays on this fork-only evidence branch, outside the code PR.

Repository regression tests need only the normal Rust/Git toolchain:

```bash
cargo test --test semgrep_baseline_test
```

Replay the native matrix with Node.js, Git, Semgrep, and a full-history RTK clone
containing both commits:

```bash
RTK_REPO=/absolute/path/to/fixed/rtk \
SEMGREP_BIN=/absolute/path/to/semgrep \
EVIDENCE_WORK=/absolute/path/to/scratch \
EVIDENCE_OUTPUT=/absolute/path/to/results \
node replay.mjs
```

Scratch and output paths should be dedicated to this replay. The harness
creates only isolated test repositories there; it does not change your RTK
checkout. Scanner credentials are not inherited, and metrics/version checks
are disabled. Fixture Rust is scanned, never compiled or executed.
