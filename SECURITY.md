# Security

## Current status

This repository contains an indexer, an aggregator, a read-only API and an optional
on-chain publisher for reputation derived from Sinetti Escrow events. There is no
supported release yet. Nothing here holds funds. The one component that spends anything
is the ERC-8004 publisher, which is opt-in, dry-run by default, and needs a funded key
supplied by the operator.

## Supported versions

There are currently no supported versions. Security support and end-of-support
information will be published with the first supported release.

## Security contacts

The maintainers listed in [MAINTAINERS.md](MAINTAINERS.md) form the security
team and receive private reports.

## Reporting a vulnerability

Use GitHub private vulnerability reporting from this repository's **Security**
tab. Do not open a public issue containing vulnerability details. Enabling and
verifying that repository setting is a publication gate; if the private-report
button is absent, publication is not complete.

Maintainers aim to acknowledge a report within three business days and provide
an initial assessment within seven business days. Please coordinate public
disclosure with the maintainers until a fix or agreed disclosure date is ready.

There is currently no bug-bounty program, and no additional safe-harbor terms
are offered by this policy.

## Trust boundaries

- **RPC endpoint.** The indexer trusts the JSON-RPC node it reads from. A lying or
  reorganising node produces wrong cards until the data is re-indexed; the
  `CONFIRMATIONS` depth limits exposure to short reorgs and nothing else.
- **Escrow address.** Pointing at the wrong address is detected (no contract code) but a
  different, hostile contract emitting the same event signatures is not; the address in
  `src/config.ts` is the trust anchor and must match the published deployment.
- **SQLite database.** Whoever can write the database can change any card. Run the API
  with read-only access to the file where the platform allows it, and back it up as an
  operator concern outside this repository.
- **Public API.** Every route is unauthenticated by design. Cards contain only data
  already public on chain, minus settled volume. Rate limiting and abuse handling belong
  to the deployment in front of the process.
- **Operator address lists.** `OPERATOR_VERIFIER_ADDRESSES` and
  `OPERATOR_ARBITER_ADDRESSES` decide the `provenance` split and are published at
  `/health`. They are configuration rather than a secret, and a wrong list misattributes deals.
- **ERC-8004 publisher.** Writes are paid, public, permanent and cannot be edited. The
  publisher verifies the agent binding before sending, refuses self-feedback, reserves
  a local row before each send so a crash cannot double-publish, and refuses to run while
  a reservation is unreconciled. The signing key is read from one environment variable
  in one module and is never written to disk by this code.
- **Feedback files.** The ERC-8004 reader fetches documents at URIs chosen by arbitrary
  raters. It fetches only `https:` and `ipfs:` (through the configured gateway), decodes
  inline `data:` URIs with a JSON media type without any request, refuses
  URLs with credentials and hosts in loopback, link-local, private, carrier-grade NAT,
  multicast and local-name ranges by literal check, caps bodies at 64 KB, follows no
  redirects, times out at ten seconds, and checks keccak-256 against the on-chain hash
  when one was given. Hostnames are not resolved before the check, so a public name that
  resolves to a private address is not caught; run the reader where that cannot reach
  anything, or add resolve-then-check before deploying it elsewhere. File contents are
  parsed as JSON and only the `settlement` field is read.
- **Registration files and agent cards.** The directory fetches the document at each
  agent's `agentURI` and the A2A agent card it names, under the feedback-file rules above,
  eight at a time, in a batch pass and never during a request. Both are written by the
  agent about itself and have no on-chain hash. Strings are capped (name 120, description
  1,000, lists 50) before storage, escaped on output, and rendered as links only for https
  URIs the reader would itself fetch. Nothing from either document enters a score. A page
  shows what the agent declared, with the time it was read.
- **Registry addresses and creation blocks.** `src/registries.ts` is the trust anchor for
  which contracts count as ERC-8004 registries. A wrong address indexes a stranger's
  events; a creation block set too high misses entries. Base mainnet's block is an
  estimate with margin, the others are from creation transactions.
- **Untrusted inputs.** Event payloads, agent cards, registry responses and feedback
  files may be malicious or malformed; the indexer, reader and publisher treat anything
  outside the expected vocabulary as unknown rather than guessing.

## Claims and verification

Security properties do not automatically transfer between implementations.
Contract privileges, pausing behavior, fund movement, fees, caps, timeout
outcomes, and arbitration behavior must be verified against the exact published
source and tests before they are documented as guarantees.

Audit, formal-verification, production-safety, and mainnet-readiness claims must
link to evidence that applies to the exact published version. Absence of a known
vulnerability is not evidence that a release is safe.
