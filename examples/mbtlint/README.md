# Use a decision from a MoonBit lint rule

The [example configuration](lint.mbtx) parses the supplied file with `mbtlint`, reads one cached decision per named test, and reports a diagnostic at the title when the predicate probability is below `0.1`.
That threshold illustrates wiring, not a calibrated policy.
The script never contacts a provider, and it never edits the source.
It does not attach a cache revision to its rule because its input includes external decisions with an expiration time.

With both modules available to the script resolver, run:

```sh
moon run --target native lint.mbtx -- sample_test.mbt /path/to/private/cache
```

Use the same scope, endpoint, model, name, instructions, and exact test declaration text when preparing entries in either language.
The demo endpoint is an identifier for offline examples, not a configured live Gateway.
An unavailable judgment exits with status `2`, a finding exits with `1`, and no findings exits with `0`.

## Verify TypeScript to MoonBit interoperability offline

From the Decision Kit checkout root, run:

```sh
MBTLINT_DIR=/path/to/mbtlint node --test examples/mbtlint/interop.test.mjs
```

Use Node.js 22.18 or later, Moon `0.1.20261119` or compatible, and a local `mbtlint` checkout that contains `test/prepare-script-home.sh` and has its dependencies cached.
The test uses that helper to prepare an isolated Moon registry and stages a locally built Decision Kit archive into it.
The TypeScript client writes the cache records using a mock transport.
The test then runs the actual native script against a test declaration containing Unicode and checks the diagnostic and exit status for a low probability, a high probability, and a missing record.
No credentials or live provider calls are required.
