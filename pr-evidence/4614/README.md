# RTK #4614: reproducible CLI evidence

- Baseline: develop `e542dca0bdcc262fa035dcf7fc33910cdcc8cdaf`.
- Fixed: `4a7619605eadb71cbfdcd5df3400764e19d7a205`.
- Real RTK debug binaries, same default features, plus the vendor's OpenShift
  `oc` 4.22.18 arm64 macOS binary (download checksum verified).
- Local simulated Kubernetes API only. No real cluster, user credentials, or
  user RTK configuration. The repository's sanitized pod fixture is adapted to
  the requested namespace. Service and log responses are synthetic.

`comparison-pods.png` and `comparison-leading.png` are browser screenshots of
real captured process output, not a product UI mockup. `cli-demo.webm` records
fresh executions of both cases. `http-comparison.json` records all 12
before/after combinations and verifies selected cluster, namespace and
impersonation headers. Wide output and logs are byte-identical control cases.

The core regression is also covered by repository tests:

```bash
cargo test --test oc_global_args_test
cargo test --lib test_oc_
```

To replay with your own two builds, use Node.js and absolute paths:

```bash
RTK_BEFORE=/absolute/path/to/original/rtk \
RTK_AFTER=/absolute/path/to/fixed/rtk \
OC_BIN=/absolute/path/to/oc \
PODS_FIXTURE=/absolute/path/to/rtk/tests/fixtures/oc_pods.json \
RTK_EVIDENCE_WORK=/absolute/path/to/scratch \
RTK_EVIDENCE_OUTPUT=/absolute/path/to/results \
node replay.mjs
```

Open the printed `demoUrl`, or request its `/matrix` endpoint. The server binds
only to 127.0.0.1 on ephemeral ports; stop it with Ctrl-C.

`startup-comparison.json` is a local release-binary wall-clock comparison,
including process-launch overhead. It is not a measurement of LLM token cost,
and does not establish a strict sub-10-ms startup guarantee.
