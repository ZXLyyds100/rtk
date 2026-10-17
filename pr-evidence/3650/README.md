# RTK #3650: permission-attestation reuse

Baseline source: `e542dca0bdcc262fa035dcf7fc33910cdcc8cdaf`.
Fixed source: `587ec0b223f99a4aa2f491a693c09246cd4f7b42`.

## What is demonstrated

- The original regression fails: an ordinary coverage estimate performs two
  calls to the attestation predicate instead of one.
- The fixed assertion passes, including Default, explicit Ask and Allow.
  Deny/defer and an absent hook retain their zero-scan short circuits.
- Unscanned wrapper Ask remains unknown and is scanned lazily once. A deliberate
  negative control treating that unknown as safe fails the wrapper/redirect
  sibling assertion. That mutation is not in the source PR.
- Twenty actual native CLI scenarios preserve complete discover report values,
  rewrite stdout and exit codes, with explicit safe/unsafe sibling assertions.
- The recording runs both native binaries against controlled 20,000-request
  transcripts. The displayed report digests match.

This is a local evidence harness, **not the RTK product UI**, a hosted CI run,
or a real agent session. Transcript commands are data and are never executed.
The predicate counter is test-only and absent from production builds.

The deterministic performance claim is only **2 -> 1 predicate calls** for an
ordinary estimate. Whole-command debug timings are noisy observations, not a
release benchmark or a claim of a 50% overall speedup.

## Files

- `discover-comparison.png`, `discover-before-after.webm`: real local CLI runs.
- `demo-before.json`, `demo-after.json`: results captured by the recording.
- `regression-before.txt`, `regression-after.txt`: actual red/green test output.
- `negative-control.txt`: intentional unsafe-cache mutation rejected by tests.
- `native-comparison.json`: twenty scenario assertions, binary hashes, and
  alternating 20k-request timing observations.
- `validation.json`: focused/full/ignored/OSS/fmt/clippy validation.
- `replay.mjs`: optional native parity harness, kept outside the source PR.

## Replay

Build normal debug RTK binaries from the two source commits in **separate
checkouts**, with each checkout's own Cargo target directory. Then, on macOS
or Linux with Node.js:

```bash
RTK_BEFORE=/absolute/path/to/baseline/target/debug/rtk \
RTK_AFTER=/absolute/path/to/fixed/target/debug/rtk \
EVIDENCE_WORK=/absolute/path/to/dedicated/scratch \
EVIDENCE_OUTPUT=/absolute/path/to/results \
node replay.mjs
```

The harness creates a fresh isolated HOME, project marker, permission settings,
transcript and database beneath its dedicated scratch directory. It does not
inherit credentials; telemetry is disabled. It refuses Windows because HOME
does not redirect every user directory there. Native Windows/Linux runners
were not executed for this submission; repository CI remains authoritative.

The source PR contains only four relevant source/documentation files. Media
and this optional replay harness remain on a fork-only evidence branch.
