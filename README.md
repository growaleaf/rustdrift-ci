# rustdrift-ci

Fail CI when your Rust version claims disagree with each other.

A project can declare its target Rust version in four different places — `rust-toolchain.toml`
(or the legacy, extension-less `rust-toolchain` file)'s `channel` field, `Cargo.toml`'s
`rust-version` field, a `Dockerfile`'s `FROM rust:X.Y`, and a GitHub Actions workflow's
`toolchain:` input on a `dtolnay/rust-toolchain` (or `actions-rs/toolchain`) step — each edited
by a different person at a different time. They drift silently, and the bug that surfaces is
"works in CI, breaks in the Docker image" (or the reverse), discovered in production, not in
review. Same shape as this lane's `nodedrift-ci`/`pydrift-ci`/`godrift-ci`/`rubydrift-ci`/
`javadrift-ci`, ported to Rust's own files.

Two notes on real ecosystem nuance, verified against primary sources, not assumed:

- `Cargo.toml`'s `rust-version` field declares a required **minimum** version (MSRV), not an
  exact pin — per doc.rust-lang.org/cargo/reference/rust-version.html — so `rustdrift-ci` only
  ever flags a pin that falls *below* that floor, never one that is newer.
- `channel` (in `rust-toolchain.toml`/`rust-toolchain`, or in a workflow's `toolchain:` input)
  is not always a version — it can legitimately be the channel name `stable`/`beta`/`nightly`
  (optionally dated). A channel name is not comparable to a version number, so it is recorded
  but never flagged as drift.

```
$ npx github:growaleaf/rustdrift-ci check
rustdrift-ci — mode: free (rust-toolchain + Cargo.toml only)
  no drift found.
  (free mode checked rust-toolchain + Cargo.toml only — Pro also checks every Dockerfile and
  GitHub Actions workflow: https://rustdrift-ci.madeforthisday.com)

$ RUSTDRIFT_KEY=... npx github:growaleaf/rustdrift-ci check
rustdrift-ci — mode: Pro (rust-toolchain + Cargo.toml + Dockerfile + CI workflows)
  DRIFT  [pinMismatch]  Pinned Rust versions disagree: rust-toolchain.toml=1.70.0, Dockerfile:1=1.78, .github/workflows/ci.yml:6=1.72
  DRIFT  [rustVersionMismatch]  rust-toolchain.toml pins Rust 1.70.0, which is below Cargo.toml's required minimum rust-version "1.75"
```

A matrix-driven CI toolchain (`toolchain: ${{ matrix.rust }}`, used to test multiple Rust
channels on purpose) resolves to a non-comparable value and is naturally excluded — never
treated as drift.

## Install

No npm account needed — install straight from the GitHub repo:

```
npm install github:growaleaf/rustdrift-ci
```

Or run it without installing:

```
npx github:growaleaf/rustdrift-ci check
```

## Usage

```
node cli.js check [--dir <path>] [--json]
```

| Exit code | Meaning |
|---|---|
| 0 | no drift found |
| 1 | a drift finding exists — fail the build on this |
| 2 | configuration error — `--dir` does not exist |

`--json` writes the full report (every source checked, every finding) to stdout, suited to a
PR-comment bot or a lint-results artifact.

## Free vs. Pro

**Free, no key needed:** compares `rust-toolchain.toml`/`rust-toolchain`'s `channel` (when it
is a real version, not a channel name) against `Cargo.toml`'s `rust-version` floor. Useful on
its own for a project with no Docker image and no CI-declared Rust version.

**Pro ($9, one time):** also scans every `Dockerfile` (any file matching `Dockerfile*`,
anywhere in the repo) and every `.github/workflows/*.yml` for a `toolchain:` input on a
`dtolnay/rust-toolchain`/`actions-rs/toolchain` step, and cross-checks every source against
every other source — this is where the real bugs are, since the Dockerfile and the CI workflow
are usually the two files furthest from active editing.

The license key is checked **offline** — an ECDSA-signed token verified locally; the CLI makes
no network call to check it, ever, and reads neither your source files nor your repository name
over the network at any point.

```
export RUSTDRIFT_KEY=<your key>       # CI secret
# or, on your own machine:
mkdir -p ~/.rustdrift && echo "<your key>" > ~/.rustdrift/license
```

Buy a key: https://rustdrift-ci.madeforthisday.com (one-time purchase, no subscription).

## How this differs from an existing tool you may already know

`cargo-msrv` finds and verifies your crate's actual minimum supported Rust version by trying to
compile it on successively older toolchains — a compilation-based check, not a cross-source
textual one. It has no notion of `rust-toolchain.toml`, a `Dockerfile`, or a CI workflow's own
declared version, and doesn't cross-check them against each other or against `Cargo.toml`'s
declared floor. A search of the npm registry and GitHub for a tool with that exact cross-check
scope turned up nothing as of 2026-11-03 — this is a narrow, specific gap, not a crowded one.

## Source

Source is readable here before you buy. The free tier works as shipped; the Pro tier needs a
key (see `LICENSE`).
