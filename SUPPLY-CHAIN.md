# Supply chain

This repository keeps its dependency surface reviewable and treats dependency
changes as release changes. This review covers this tree at this state and was
performed on 10 September 2026. Before publication, the same checks must run
against the exact commit being published; this is evidence about one
reviewed tree at one moment, and it says nothing about future installs.

## What ships and what builds

`package.json` lists six direct runtime dependencies: `ajv`, `ajv-formats`,
`better-sqlite3`, `dotenv`, `ethers`, and `express`. These are what the
indexer, aggregator, and read-only API need at run time. `npm ls --omit=dev
--depth=0` resolves them to `ajv@8.20.0`, `ajv-formats@3.0.1`,
`better-sqlite3@11.10.0`, `dotenv@16.6.1`, `ethers@6.17.0`, and
`express@5.2.1`. `better-sqlite3` is a native module: its install script
compiles a binary against the local Node headers, so a reader running `npm
install` should expect a native compile step as part of that install.

The `devDependencies` group covers the build and test toolchain: Hardhat and
its toolbox, `ts-node`, TypeScript, `supertest`, and the `@types/*` packages,
which compile and test the code and are absent from a deployed runtime.
`npm ls --depth=0` lists 17 direct dependencies across both groups. The
package has no `engines` field; CI pins Node 22 in `ci.yml`, but that pin is
not enforced on a local or production install.

The lockfile is `lockfileVersion: 3` and holds 680 package entries. Of those,
679 resolve to `https://registry.npmjs.org/`; the manifest package itself
accounts for the one entry without a `resolved` field. No entry resolves to a
Git, file, or arbitrary URL source.

## Installation scripts

Four locked packages declare installation scripts:

| Package | Version | Why present |
|---|---:|---|
| `better-sqlite3` | `11.10.0` | Native SQLite binding compiled on install; a direct runtime dependency |
| `fsevents` | `2.3.3` | Optional filesystem events support on macOS |
| `keccak` | `3.0.4` | Native hashing dependency pulled in by the Ethereum/Hardhat toolchain |
| `secp256k1` | `4.0.4` | Native elliptic-curve dependency pulled in by the Ethereum/Hardhat toolchain |

This repository has no `scripts/check-dependencies.mjs` pinning this list and
failing CI on a new or changed installation script, the way `sinetti-escrow`
does. A new script arriving through a dependency bump will not be caught.

## Advisory findings

`npm audit --omit=dev --json` against this tree reports 0 advisories reachable
from the production dependency tree. Two were present before this review and
were closed by `npm audit fix --omit=dev`, which moved `fast-uri` from 3.1.3 to
3.1.7 (six host-confusion and SSRF advisories, reached through `ajv`) and `qs`
from 6.15.3 to 6.16.0 (two advisories, reached through `express` and the dev
dependency `supertest`). The full test suite passed after the change.

`npm audit --json` against the full lockfile, including development
dependencies, reports 38 findings: 13 low, 7 moderate, 18 high, 0 critical.
All of them sit in the Hardhat/toolbox chain and related packages
(`@nomicfoundation/hardhat-*`, `mocha`, `solc`, `solidity-coverage`, `js-yaml`,
`lodash`, `elliptic`, `undici`, and others) and do not reach the runtime tree.
Closing them is the Hardhat toolbox migration that Sinetti-Escrow has parked
for the same reason; it is a real upgrade, done as its own change.

## `scripts/check-publication.mjs`

This script is the repository's publication gate. It walks the tracked tree
(skipping `node_modules`, `.git`, and build output directories) and fails on
a symlink, a file over 1 MB, a forbidden pattern (absolute home-directory
paths, internal project names, and similar leakage markers), or a Markdown
link to a local file that does not exist. `npm run check:publication` runs it,
and CI calls it on every push and pull request. It checks tree hygiene and
leakage patterns; package sources, integrity hashes, and installation scripts
sit outside its scope. No license scan of the lockfile has been run as part
of this review.

## GitHub Actions and Dependabot

Every `uses:` step in `.github/workflows/ci.yml`, `release.yml`, and
`scorecard.yml` is pinned to a full commit SHA: `actions/checkout`,
`actions/setup-node`, `ossf/scorecard-action`, `actions/upload-artifact`,
`github/codeql-action/upload-sarif`, and `sigstore/cosign-installer`.

`.github/dependabot.yml` covers `npm` and `github-actions`, each on a weekly
Monday schedule with grouped pull requests (one for version updates, one for
security updates) and a seven-day cooldown on version updates that does not
apply to security updates. `.gitleaks.toml` extends gitleaks' default
ruleset and allowlists paths under `deployments/*.json`, where
contract-address fields under keys like `token` would otherwise
false-positive as credentials.

## Gaps found in this review

- CI runs `npm run audit:dependencies` (production tree, high and above) with
  the same retry Escrow uses, added in this review.
- No script pins the allowlist of packages permitted to run installation
  scripts.
- No workflow invokes gitleaks; `.gitleaks.toml` is not wired into CI.
- No license scan has been run against the lockfile.

## Limits

Integrity hashes detect changed downloads; they do not prove an upstream
package is trustworthy. Advisory databases cover disclosed vulnerabilities;
unknown defects and malicious maintainers fall outside them. Commit-SHA
pinning and the publication-path check reduce risk. They do not replace
minimizing dependencies, closing the gaps above, or reviewing code that
handles keys, indexed on-chain data, and the read-only API surface.
