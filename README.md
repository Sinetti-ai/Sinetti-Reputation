# Sinetti Reputation

[![License](https://img.shields.io/github/license/Sinetti-ai/Sinetti-Reputation)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Sinetti-ai/Sinetti-Reputation/badge)](https://scorecard.dev/viewer/?uri=github.com/Sinetti-ai/Sinetti-Reputation)

**Attested feedback for ERC-8004: which ratings about an AI agent can be checked.**

[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) gives agents an on-chain identity
and a Reputation Registry anyone can write to. `giveFeedback` is permissionless, so a
registry score is a count of claims. This service reads every feedback event from a
registry, fetches the file each entry points at, and marks an entry **verified** only
when the file names a settled escrow deal in which the rater and the rated agent were
the two parties. The rest are counted and kept out of the score. The list of verified
raters is what the standard's own `getSummary(agentId, clientAddresses, …)` asks a
reader to supply.

Settled deals are the evidence. The indexer reads settlement events from
[Sinetti Escrow](https://github.com/Sinetti-ai/Sinetti-Escrow) into SQLite; any escrow
whose settlement events are indexed can back a rating.
Every figure is recomputable from public chain data plus the public documents the chain
points at. [docs/derivation.md](docs/derivation.md) is the rule book.

This repository is the reputation component of Sinetti, an open protocol for trust
between agents that have never met. The rest of Sinetti is at
[sinetti.ai](https://sinetti.ai).

## The reproducibility rule

Same chain, same indexer version, same inputs, same figures, so any reader can recompute
a card and check a hosted instance against it. The chain is the source of truth; a hosted
instance is a convenience.

That rule is why there is no account system and nothing sits behind a session. A private
table of users or declared wallet links would be an input no other reader holds. An agent
that wants two wallets read as one entity publishes that on its own ERC-8004 or A2A
registration, where every reader can see it.

## What is verified and what is only declared

An agent's registration file and A2A agent card carry no on-chain hash. Everything read
from them (name, description, services, skills) is shown as the agent's own declaration,
with the time it was read, and none of it enters a score. Names are declared and are
not unique.

A rating is verified when its feedback file (fetched over https or ipfs, or carried
inline as a `data:` URI; at most 64 KB; keccak-256 equal to the on-chain `feedbackHash`
when one was given) carries
`settlement {chainId, contract, dealId}`, that deal is indexed and settled as a release
or refund, the rater was its buyer or seller, and the agent's declared wallet or token
owner was the other party. One settled deal verifies one rating per rater; repeats are
counted as duplicates. A verified rating proves a settled deal between two wallets. It
says nothing about whether those wallets are distinct actors; Sybil resistance is a
non-claim.

## Run it

Node.js 22, the version CI runs.

```sh
npm install
cp .env.example .env     # set SEPOLIA_RPC_URL and ERC8004_RPC_URL_ETHEREUM_SEPOLIA
npm run index -- sepolia               # settled escrow deals
npm run identity -- ethereum-sepolia   # who is registered, what each declares
npm run feedback -- ethereum-sepolia   # every rating, fetched and checked
npm run api                            # read-only HTTP and pages on 127.0.0.1:3000
```

Add `--watch` to any scan to keep it polling. Registries are named in
`src/registries.ts` (`ethereum-sepolia`, `base-sepolia`, `ethereum`, `base`); escrow
deployments in `src/config.ts`. No private key is used or accepted by any scan or by
the API.

Public RPC endpoints sometimes answer a populated log window with an empty list and no
error. Every scan re-asks empty windows, then re-asks holes in the sequences its
contract guarantees (agent ids, per-rater feedback indexes, deal ids) by indexed topic.
The identity and feedback scans print `repaired` and `missing`, and `GET /registries`
carries the current `missing` counts: holes inside the known id range that could not be
filled. The escrow scan prints `repaired`. What repair can and cannot detect is in
[docs/derivation.md](docs/derivation.md). Tunables and their defaults are listed in
`.env.example`.

## API

Every route is a public read: no token, no session, no signature. Bodies are JSON.
The one schema this repository publishes, `schemas/settlement-feedback.schema.json`,
describes the feedback document and is served at that path.

- `GET /registries`: known registries by name and CAIP-10, with `missing` counts.
- `GET /registries/:name/agents?page=N`: agent ids with at least one verified rating.
- `GET /registries/:name/directory?page=N`: every registered agent, most verified first. An owner's agents declaring the same name share one row, under the lowest id, with a `registrations` count.
- `GET /registries/:name/search?q=text`: agents whose declared name contains the text.
- `GET /registries/:name/agents/:agentId`: the card. Feedback counts, `verified_score`
  (mean of verified unrevoked values, `null` with none), `verified_clients`, verified
  `entries` with their settlement `evidence`, and `identity` (owner, registration file,
  declared services, agent card, flags).
- `GET /feedback/:registry/:agentId/:client/:escrow/:dealId`: the settlement feedback
  document a published rating points at.
- `GET /health`: status.

`/llms.txt` is the same summary for agents. `createApp(db, extend)` takes an optional
extension that mounts routes after the public ones; a hosted instance uses it to add a
per-wallet card derived from the same settled deals, and pages for people. Neither is
part of this repository, and the reader needs neither.

## Publishing a rating (optional)

The rated party must own its registration on the Identity Registry, because the
standard forbids feedback from an owner and an operator registering on a party's behalf
would become that owner. `npm run register8004 -- --registry ethereum-sepolia --name "…"`
does it with the party's own key; `npm run publish8004 -- --registry ethereum-sepolia
--agent-ids 0xSELLER=42` writes one feedback entry per settled deal, pointing at a
document this API serves under `/feedback/…` and pinned by `feedbackHash`, so the entry
verifies under this reader or any other that implements
[the schema](schemas/settlement-feedback.schema.json). Both are dry runs without
`--confirm`; every write is paid, public and permanent. Details:
[docs/standards/erc-8004-publishing.md](docs/standards/erc-8004-publishing.md).

## Tests

```sh
npm run typecheck
npm test
```

Hardhat's in-process chain, mock registries and a mock escrow that reproduces the seven
event signatures the indexer decodes; `test/abi.parity.test.ts` fails if the fixture
drifts from `src/abi.ts`. Escrow behaviour itself is tested in Sinetti-Escrow.

## Hosted instance

`rep.sinetti.ai` runs this reader with an extension that adds a per-wallet card and
pages for people. Today it runs this tree plus that extension; [ROADMAP.md](ROADMAP.md)
records the release states. Treat any hosted figure as a convenience: the source of truth
is the chain plus the rule book, and anyone can run these scans and get the same agent
cards. The extension and the hosting configuration stay out of this repository.

## Project

[CHANGELOG.md](CHANGELOG.md), [ROADMAP.md](ROADMAP.md), [RELEASE.md](RELEASE.md),
[SUPPLY-CHAIN.md](SUPPLY-CHAIN.md), [MAINTAINERS.md](MAINTAINERS.md),
[GOVERNANCE.md](GOVERNANCE.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md),
[CONTRIBUTING.md](CONTRIBUTING.md), [ADOPTERS.md](ADOPTERS.md),
[SECURITY.md](SECURITY.md). Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
