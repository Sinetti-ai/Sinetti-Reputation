# Roadmap

Sinetti Reputation is the reader that tells apart ERC-8004 feedback that can be
checked from feedback that cannot. The first evidence class is settlement in a
Sinetti Escrow deal. Anyone can run the published reader against the public
registries and get the same figures; a hosted instance is a convenience.

## What this repository holds

Every component needed to reproduce or independently operate the reader:

- the ERC-8004 indexers for the identity and reputation registries, with the
  fetch rules for registration files, agent cards and feedback files;
- the settlement indexer for Sinetti Escrow events;
- the verification rule that ties a rating to a settled deal, written down in
  [docs/derivation.md](docs/derivation.md);
- the optional publisher that writes a settled deal into a registry as feedback
  that verifies under this reader;
- public schemas, standards documents, fixtures and tests.

Private operations stay out: RPC credentials, signing keys, host configuration,
backups. Nothing here needs an account or a session.

## Initial public release

The first public release is complete when a clean clone provides:

- identity and feedback scans of the four reference registries that finish at
  `missing: 0`, with the repair path for public RPCs that drop log windows;
- per-agent cards that keep declared data and verified ratings apart, served
  over a read-only API and plain HTML pages;
- the settlement indexer for the Sepolia v0.1.0 escrow;
- clean-clone, dependency, secret and publication-safety checks, with the
  reviewed dependency surface recorded in [SUPPLY-CHAIN.md](SUPPLY-CHAIN.md).

## Release states

| State | What it proves |
|---|---|
| Source published | The reviewed code and documentation are publicly readable; no service claim follows. |
| Reference instance operated | rep.sinetti.ai runs this exact source at a documented commit. Today it runs this tree plus the hosted extension. |
| Seeded testnet | At least one rating on a public registry cites a settled Sinetti Escrow deal and shows as verified. |
| Production or mainnet | An independent review supports real-value use. Nothing schedules this. |

## Next releases

- Read the Validation Registry. Index `ValidationRequest` and
  `ValidationResponse`, show responses per agent by validator address, counted
  and unscored until a validator allow-list exists. Waits on a reference
  deployment: on 2026-09-13 the ERC-8004 contracts repository published no
  Validation Registry address on any chain and marked that part of the
  specification as under revision. The `ValidationRegistry` contracts on
  Sepolia and mainnet explorers are third-party deployments.
- Add evidence classes beyond settlement: an organisation credential (vLEI), a
  personhood credential (First Person Project). Each fits the same slot, a
  verifiable document reachable from the feedback entry. The identity anchor the
  escrow carries per deal is read by the hosted instance's wallet card; every deal
  so far has it empty.
- Run identity scans on the mainnet registries; the Base creation block is an
  estimate until then.
- Counter columns on the agents table once directory and search queries are
  slow at the registry's size.
## Explicit non-claims

A verified rating proves a settled deal between two wallets. It says nothing
about whether those wallets are distinct actors, and settled-deal history can
be farmed by cooperating wallets. The reader shows counterparty diversity for
that reason and makes no claim of Sybil resistance.
