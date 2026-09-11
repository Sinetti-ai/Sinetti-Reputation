# Sinetti Reputation

[![License](https://img.shields.io/github/license/Sinetti-ai/Sinetti-Reputation)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Sinetti-ai/Sinetti-Reputation/badge)](https://scorecard.dev/viewer/?uri=github.com/Sinetti-ai/Sinetti-Reputation)

**Attested feedback for ERC-8004: which ratings about an AI agent can be checked.**

[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) gives agents an on-chain identity
and a Reputation Registry anyone can write to. `giveFeedback` is permissionless, so a
registry score is a count of claims, and the deployed registries are known to be
sybil-flooded. This service reads every feedback event from a registry, fetches the
file each entry points at, and marks an entry **verified** only when the file names a
settled escrow deal in which the rater and the rated agent were the two parties. The
rest are counted and kept out of the score. The list of verified raters is exactly what the
standard's own `getSummary(agentId, clientAddresses, …)` asks a reader to supply.

Settled deals are the evidence. The indexer reads settlement events from
[Sinetti Escrow](https://github.com/Sinetti-ai/Sinetti-Escrow) deployments into SQLite
and derives a reputation card per wallet; any escrow whose settlement events are indexed
can back a rating. Everything is served through a read-only, unauthenticated HTTP API,
and every figure is recomputable from public chain data plus the public documents the
chain points at. [docs/derivation.md](docs/derivation.md) is the rule book.

Other kinds of proof a rater could present, such as an organisation credential or a
personhood credential, fit the same slot: a verifiable document reachable from the
feedback entry. None is implemented here yet; the credential formats are still being
standardised.

This repository is the reputation component of Sinetti, an open protocol for
trust between agents that have never met. The rest of Sinetti is at
[sinetti.ai](https://sinetti.ai). The escrow contract whose events this reads,
and its event definitions, live in Sinetti-Escrow; this repository carries only
the event ABI and a test fixture so it can be developed on its own.

## The reproducibility rule

Every figure this service serves is derived from public chain events. Same chain, same pinned
indexer version, same wallet, same card, so any reader can recompute a card and check this
endpoint against it. The chain is the source of truth; a hosted instance is a convenience.
The one instance-dependent field is `provenance`, which splits settled deals by whether a
verifier or arbitrator from the instance's operator address lists took part; those lists are
published at `GET /health` so that field is reproducible too.

That rule is why there is **no account system**. A private table of users, declared wallet
links, or contact details would be an input no other reader holds, and the card would stop
being reproducible. It is also why nothing here is behind a session: the data is derived from
public events, so gating it would protect nothing that is not already public.

An agent that wants two wallets read as one entity, or wants contact details attached to its
identity, publishes that on its own ERC-8004 or A2A registration, where every reader can see
it. That record is the agent's to keep.

## Status

- **ERC-8004 reader.** Indexes `NewFeedback` and `FeedbackRevoked` from the reference
  registries on Ethereum Sepolia, Base Sepolia, Ethereum and Base; fetches feedback files
  under strict rules; verifies settlement claims; serves per-agent cards (`src/feedback.ts`,
  `src/registries.ts`).
- **Settlement evidence.** Log indexing of Sinetti Escrow, persistence, aggregation, JSON
  Schema validation, a CLI, and a read-only JSON API for wallet cards.
- **Reputation as graph.** The anti-wash-trading graph, provenance, and trust-tier fields.
- **Human surface.** A server-rendered read-only web surface (`src/web.ts`: front door,
  registry and agent pages, wallet card pages, `/llms.txt` for agent discovery).
- **Publisher (optional).** Writes Sinetti settlements into a registry as feedback whose
  file carries the settlement claim, so they verify under this reader.

Not yet built: credential-based proof (organisation or personhood), seeded reputation
volume, and a hosted instance running this exact source.

## Setup

Requires Node.js 20 or newer.

```sh
npm install
cp .env.example .env
```

Set `SEPOLIA_RPC_URL` to an Ethereum Sepolia JSON-RPC endpoint for the escrow indexer, and
`ERC8004_RPC_URL_<REGISTRY>` (for example `ERC8004_RPC_URL_ETHEREUM_SEPOLIA`, `ERC8004_RPC_URL_BASE`)
or a shared `ERC8004_RPC_URL` for the registries you read. No private key is used or accepted:
the indexer and reader only call read methods and fetch logs and blocks.

Deployments live in `src/config.ts`:

- `sepolia`: chain ID `11155111`, escrow `0x73862690E12621b3BC5749281CE4b23fe4a1695c`
  (SinettiEscrowV04 v0.1.0, deployed 2026-09-03, block 11628623).
- `local`: chain ID `31337`, address from `LOCAL_CONTRACT_ADDRESS`, and RPC from `LOCAL_RPC_URL`.

The indexer reads one escrow vocabulary, V04's. The retired `SinettiEscrowV02` deployment at
`0x72C637Aa391693c8dFc741F3AB7fC81E6120158b` is no longer indexable, and support for it was
removed along with the dual-classification path it required. The two disagreed about outcomes,
since V02's `Refunded` state ordinal is V04's `Released`.

Pointing a deployment at an address with no contract code fails at startup and on every
watch poll. Fetching no matching topics would report zero events and look healthy. Two nodes of
one network announce the same chain id, so the address is the only thing separating them.

`fromBlock` is pinned to the Sepolia deployment's actual block to keep backfills from scanning unnecessary history; re-pin it whenever the Sepolia deployment address changes. Log ranges are chunked using `LOG_CHUNK_SIZE` (default `2000`). Public RPC endpoints answer some populated windows with an empty list and no error (publicnode Sepolia did so about one call in two on 2026-09-10, in runs); every indexer re-asks an empty window (`LOG_EMPTY_RETRIES`, default 5, `LOG_EMPTY_RETRY_DELAY_MS`, default 400), and each scan then re-asks holes in the sequences its contract guarantees by indexed topic: agent ids and per-pair feedback indexes for the registries, deal ids and deals with no `Settled` event for the escrow. Each scan prints `repaired` and `missing`, and `GET /registries` carries the current `missing` counts per registry; non-zero means the RPC never answered that hole and the index is short. A hole is re-asked at most once an hour per process so a watch loop does not spend its budget on an unrecoverable one. The indexer leaves the newest `CONFIRMATIONS` blocks unprocessed (default `5`) to avoid persisting data from short reorgs; mainnet deployments should use a larger confirmation depth appropriate to their risk tolerance.

## Run

One-shot Sepolia backfill:

```sh
npm run index -- sepolia
```

Continuous polling:

```sh
npm run index -- sepolia --watch
```

Read an ERC-8004 registry (record feedback events, then fetch and verify each file):

```sh
npm run feedback -- ethereum-sepolia
npm run feedback -- base --watch
npm run feedback -- base --recheck
```

Files are checked in batches of `CHECK_BATCH` (default 200) between index passes. An
unreachable file is retried after a day; `--recheck` resets every entry on the registry.

Read the identity side (record every `Registered` and `URIUpdated` event, then fetch each
agent's registration file and, when it lists an A2A service, its agent card):

```sh
npm run identity -- ethereum-sepolia
npm run identity -- base --watch
```

Eight files are in flight at once, `CHECK_BATCH` (default 400) agents per pass. Every agent
is re-read a day after its last read, or at once when its URI moves. Registration files and
agent cards carry no on-chain hash; everything read from them is shown as the agent's own
declaration with the time it was read, and none of it enters a score.

Registries are named in `src/registries.ts`: `ethereum-sepolia`, `base-sepolia`, `ethereum`,
`base`. Each has a verified address pair and a creation block. Feedback files are fetched
over https or through the IPFS gateway in `IPFS_GATEWAY` (default `https://ipfs.io/ipfs/`),
capped at 64 KB, refused for private hosts, and checked against the on-chain `feedbackHash`.
Inline `data:` URIs with a JSON media type are decoded in place; a third of Sepolia
registrations use them.

Start the localhost-only API:

```sh
npm run api
```

The local deployment defaults to the RPC URL `http://127.0.0.1:18546`, chosen so it does not collide with Hardhat's default port.

SQLite defaults to `data/sinetti-rep.db`. Each deployment has an independent last-indexed block checkpoint. Raw logs use transaction hash plus log index as an idempotency key, so interrupted backfills can resume without duplicating records.

## API

All response bodies are JSON. Every route is public: there is no token, no session, and no
signature step.

- `GET /health` — health check and the operator address lists.
- `GET /registries` — the ERC-8004 registries this instance knows, by name and CAIP-10.
- `GET /registries/:name/agents` — agentIds with at least one verified rating, with the name
  each declares.
- `GET /registries/:name/directory?page=N` — every agent registered on the identity
  registry, most verified first, 100 per page.
- `GET /registries/:name/search?q=text` — agents whose declared name contains the text.
  Names are declared by agents and are not unique.
- `GET /registries/:name/agents/:agentId` — the card for one agent: verified feedback plus
  `identity` (owner, registration file, declared services, A2A agent card, flags).
- `GET /agents` — wallet directory; it lists addresses already public in the escrow
  contract's on-chain events.
- `GET /agents/:address` — the settlement-derived card for one wallet.
- `GET /feedback/:registry/:agentId/:client/:escrow/:dealId` — the settlement feedback
  document a Sinetti-published rating points at; `:registry` and `:escrow` are CAIP-10.

`GET /registries/:name/agents/:agentId`:

```json
{
  "registry": "eip155:11155111:0x8004B663056A597Dffe9eCcC1965A193B7388713",
  "agent_id": "42",
  "feedback": { "total": 300, "revoked": 2, "unchecked": 0, "verified": 1, "duplicates": 0 },
  "verified_score": 0,
  "verified_clients": ["0x..."],
  "entries": [
    {
      "client": "0x...", "feedback_index": 0, "value": "0", "value_decimals": 0,
      "tag1": "ruling_refund", "tag2": "eip155:11155111:0x7386...", "feedback_uri": "https://...",
      "block_number": 11700000, "block_timestamp": 1789000000, "tx_hash": "0x...",
      "evidence": {
        "deployment": "sepolia", "chainId": 11155111, "contract": "0x7386...", "dealId": "6",
        "resolution": "refund", "clientRole": "buyer", "agentAddress": "0x...", "settledAt": 1788900000
      }
    }
  ]
}
```

`verified_score` is the mean of verified, unrevoked values on their own decimal scale, and
`null` when there are none. One settled deal verifies one rating per rater; repeats are
`duplicates`. Unverified entries appear only in the counts.

`GET /health`:

```json
{ "status": "ok" }
```

`GET /agents` lists every wallet seen in a deal role and its settled deal count:

```json
{
  "agents": [
    { "address": "0x...", "deals_settled": 2 }
  ]
}
```

`GET /agents/:address` returns the card for one wallet. Every reader gets the same card — there is no viewer-dependent projection, because the underlying data is public either way.

```json
{
  "address": "0x...",
  "started_at": "2026-07-10T23:45:00.000Z",
  "deals_settled": 2,
  "outcomes": { "release": 1, "refund": 0, "refund_and_slash": 1 },
  "rates": { "success_rate": 0.5, "dispute_rate": 0.5, "timeout_rate": 0 },
  "bonds": { "posted_count": 1, "slashed_count": 1, "returned_count": 0 },
  "roles": { "as_buyer": 0, "as_seller": 2 },
  "repeat_counterparty": true
}
```

Rates are transparent ratios over settled deals: releases / settled, deals with `DisputeOpened` / settled, and timeout refunds / settled. Outcomes are attributed to buyer, seller, arbiter, and verifier. Buyer/seller role counts and seller bond lifecycle counts are reported separately.

The internal card computes `settled_volume` as raw base units, token address, and decimals-formatted units when all settled deals use one token. It is deliberately stripped from every API response to reduce wallet financial profiling. Cards carry no transaction lists or per-deal breakdowns; those records remain in SQLite. Responses are validated against `schemas/reputation-card.schema.json` with Ajv before serving.

Settled-deal history is wash-tradeable in principle: cooperating wallets can cheaply settle deals among themselves to farm a clean record. Trust tiers and the independent-counterparty share discount clustered activity, which raises the cost of farming without eliminating it. Read scorecards with counterparty diversity in mind.

A card covers exactly one wallet. Counterparty independence is computed at wallet level: every
graph node is its own identity, and nothing on the server merges two wallets into one entity.

This is a deliberate narrowing. An earlier version resolved each node through a declared
`wallet_links` table so an account's wallets collapsed into one counterparty. That table was
removed for two reasons. It was a private input no other reader held, which broke
reproducibility; and it left the attack it was built for unbounded, because declaring a link was
voluntary and a wash trader simply declined to.

Catching sybils (wallets that are the same real-world actor) is out of scope for this repo by
design. Any reader can run that analysis over the same raw `deals` and `raw_events` tables.

## Publishing to ERC-8004 (optional)

The rated party must hold its own registration on the Identity Registry; an operator
registering on its behalf would become the owner, and the spec forbids feedback from an
owner. `npm run register8004 -- --registry ethereum-sepolia --name "…"` does that with
the party's own key in `REGISTRANT_PRIVATE_KEY`: two transactions, mint then a URI
rewrite so the inline registration file names its own agentId. Dry run without `--confirm`.


`scripts/publish-erc8004.ts` can write each settled deal's outcome as feedback into an
ERC-8004 Reputation Registry. Each entry's `feedbackURI` is a per-deal settlement document
served by this API (`/feedback/…`), carrying the `settlement` claim and pinned by
`feedbackHash`, so Sinetti's own ratings verify under this reader or any other that
implements [the schema](schemas/settlement-feedback.schema.json). Publishing is off by
default: it needs `--registry`, an explicit wallet-to-agentId mapping, a funded key in
`ERC8004_PRIVATE_KEY`, and `--confirm`. Without `--confirm` it prints the plan and writes
nothing. Every write is paid, public and permanent. The publisher reserves a local row
before each send, so a crash between sending and recording cannot publish the same deal
twice; a reservation that never recorded its receipt blocks further publishing until the
operator reconciles it against the chain. Design notes:
[docs/standards/erc-8004-publishing.md](docs/standards/erc-8004-publishing.md).

## Web surface

The same Express app also serves a human-facing, server-rendered web surface (`src/web.ts`) —
no client JavaScript, no new dependencies, no cookies. This service is **agent-first**: the
JSON API above is the real board; the web surface exists only as a front door for humans.

- `GET /` — one lookup box: a declared name, a wallet address, or `registry/agentId`.
- `GET /search?q=text` — declared names across every known registry; one exact match
  opens the card, anything else is a list.
- `GET /r/:registry?page=N` — verified agents on one registry, then the full directory.
- `GET /r/:registry/:agentId` — the card for one agent: what it declares (registration
  file, services, A2A agent card and skills, flags), then its ratings.
- `GET /a/:address` — the wallet card for one address, rendered as a page. Identical for
  every visitor.
- `GET /llms.txt` — plain-text machine-discovery document for agents: the endpoint list and how
  to read a card.
- `GET /terms` — combined terms of service and privacy notice for the testnet pilot.

Every route is a read. No mutation forms exist anywhere on the web surface, and no route sets
a cookie.

## Tests

```sh
npm run typecheck
npm test
```

The integration test deploys `MockEscrowV04` and a 6-decimal mock token to Hardhat's in-process network, settles the verifier-pass, arbitrator-ruled release, arbitrator-ruled refund-with-slash, and timeout paths, indexes the resulting logs in chunks, verifies resumability, and checks exact aggregate cards. It never starts or contacts a local JSON-RPC port.

`contracts/mocks/MockEscrowV04.sol` is a test fixture. The real contract is `contracts/SinettiEscrowV04.sol` in Sinetti-Escrow, which needs a newer compiler and a pinned OpenZeppelin, so the fixture is written for this package's compiler. It reproduces the seven event signatures the indexer decodes and nothing else: no authorisation, no EIP-712 acceptance, no window arithmetic, no state-machine enforcement. `test/abi.parity.test.ts` fails if its events drift from `src/abi.ts`. Escrow behaviour is tested in Sinetti-Escrow, against the contract that actually has those properties.

## Hosted instance

`rep.sinetti.ai` answers, and this repository does not say which version it runs: the
hosted instance is operated separately and lags this source until it is repointed. Treat
any hosted card as a convenience. The source of truth is the chain plus
[docs/derivation.md](docs/derivation.md), and anyone can run this indexer against the
Sepolia escrow and get the same cards. Hosting configuration (service units, tunnel
routes, backups) is instance-specific and stays out of this repository.

## Project

- Releases: none yet; [CHANGELOG.md](CHANGELOG.md) will summarise each release and
  [RELEASE.md](RELEASE.md) says how releases are made, signed and verified.
- People and decisions: [MAINTAINERS.md](MAINTAINERS.md),
  [GOVERNANCE.md](GOVERNANCE.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Using it somewhere? Add your organisation or project to [ADOPTERS.md](ADOPTERS.md)
  with a verifiable reference. Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).
- Security: [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
