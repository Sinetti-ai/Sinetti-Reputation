# ERC-8004: reading and publishing

**Status of the ERC:** `Draft` at
[eips.ethereum.org/EIPS/eip-8004](https://eips.ethereum.org/EIPS/eip-8004), read on
2026-09-10. It moved backwards from Review; no recorded reason has been found, so none is
asserted here.

## The finding this rests on

ERC-8004's Reputation Registry persists five fields per feedback entry (`value`,
`valueDecimals`, `tag1`, `tag2`, `isRevoked`) and emits, without storing, `endpoint`,
`feedbackURI` and `feedbackHash`. `giveFeedback` is permissionless: "New feedback can be
added by any clientAddress". The deployed scores reflect that.
[arXiv 2606.26028](https://arxiv.org/abs/2606.26028), *Can Trustless Agents Be Trusted?*,
covering deployment through 2026-05-13, finds coordinated sybil behaviour in 73.5% of
reviewers on Ethereum, 59.2% on BSC and 90.6% on Base; after removing sybil-flagged
feedback, 86.8% of rated agents on Base have no valid feedback left.

The standard leaves the hook for this: `getSummary(agentId, clientAddresses, tag1, tag2)`
takes the list of raters to count. It does not say how to build that list. This service
does.

## Read every claim. Trust no score.

The reader (`src/feedback.ts`) indexes `NewFeedback` and `FeedbackRevoked` events, fetches
each entry's feedback file, and verifies the `settlement` claim in it against indexed
escrow deals. The rules are in [docs/derivation.md](../derivation.md), "ERC-8004 feedback
verification". A verified entry is one whose rater provably settled a deal with the agent;
everything else is counted and never scored.

The registry's own summary and read functions are never called. `REPUTATION_REGISTRY_EVENTS_ABI`
in `src/registries.ts` holds events only, the publisher's `REPUTATION_REGISTRY_ABI` holds
one function, and tests hold both to that shape. There is no code path that can return a
registry score into a card.

Identity-registry reads are a different thing and are used by both sides: `getAgentWallet`
and `ownerOf` answer *who* an agentId is bound to, never how good anyone is.

## The identity side

The Identity Registry is an ERC-721. `Registered(agentId, agentURI, owner)` and
`URIUpdated(agentId, newURI, updatedBy)` are indexed; `MetadataSet` is not, since nothing
read so far uses on-chain metadata for anything a card shows. The registration file the
URI points at follows the ERC-8004 registration schema: `name`, `description`, `image`,
`active`, `services` (each `{name, endpoint, version}`, with `A2A`, `MCP`, `web`, `ENS`,
`DID` and `email` as named endpoint types), `registrations` and `supportedTrust`. Early
files used `endpoints` for `services`; both are read and the key is recorded. About a third
of Sepolia registrations carry the file inline as a `data:application/json` URI; those are
decoded in place and nothing is fetched.

ERC-8004 sits under Agent2Agent (A2A). The `A2A` service endpoint is the agent's card, by
convention at `/.well-known/agent-card.json`. The reader fetches it under the same rules and
records name, provider, version, protocol version, capabilities, skills, default modes,
security scheme names and whether `signatures` are present. Signatures are not verified.

Neither document has an on-chain hash. Everything read from them is a declaration by the
agent, shown as such with the time of reading, refreshed daily or on `URIUpdated`, and kept
out of every score. Verified ratings may carry A2A `skills` and `taskId` from the feedback
file; they are matched to the card's skills for display.

## Registry deployments

The reference deployments from
[github.com/erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts),
probed on 2026-09-10 by `eth_getCode` at each address and `getIdentityRegistry()` on each
reputation registry:

| Name | Chain | Identity | Reputation | Identity created | Reputation created |
|---|---|---|---|---|---|
| `ethereum-sepolia` | 11155111 | `0x8004A818…4BD9e` | `0x8004B663…88713` | block 9989393 | block 9989394 |
| `base-sepolia` | 84532 | `0x8004A818…4BD9e` | `0x8004B663…88713` | block 36304145 | block 36304146 |
| `ethereum` | 1 | `0x8004A169…9a432` | `0x8004BAa1…E9b63` | block 24339871 | block 24339873 |
| `base` | 8453 | `0x8004A169…9a432` | `0x8004BAa1…E9b63` | estimate | estimate, see below |

All four are ERC-1967 proxies (implementation `ReputationRegistryUpgradeable`). Creation
blocks for the first three are from the creation transaction Blockscout records for each
proxy (identity one to two blocks before reputation on every chain). Base mainnet's Blockscout exposes no creation transaction for it; its block is the
Ethereum mainnet creation time mapped onto Base's two-second blocks, minus a margin, so
the first scan reads some empty history rather than missing entries. Public RPC nodes
serve no historical `eth_getCode`, so the block could not be bisected there.

An earlier, non-proxied pair (`0xB504…9e322` / `0x7177…dd09A`) still has code on Ethereum
Sepolia. It is not the reference deployment and is not read.

The reader refuses to start against an address with no code, so a chain where the
registries are absent fails rather than indexing nothing and looking healthy.

## What the publisher writes

One feedback entry per settled deal, subject = the **seller** (reputation here is a claim
about whether delivery happened, so it belongs to the party that owed it).

| Field | Value | Why |
|---|---|---|
| `value` | `100` release, `0` refund, `0` refund-and-slash | See below. |
| `valueDecimals` | `0` | Integer 0–100 scale. |
| `tag1` | the outcome string | Stored *and* indexed in the event; carries the distinction the number loses. |
| `tag2` | CAIP-10 of the Sinetti escrow | Stored, so a reader can summarise per deployment. |
| `endpoint` | `""` | The agent's own service endpoint, which Sinetti does not know. |
| `feedbackURI` | `https://rep.sinetti.ai/feedback/{registry}/{agentId}/{client}/{escrow}/{dealId}` | The settlement document; see below. |
| `feedbackHash` | keccak-256 of that document | Pins the bytes the reader will fetch. |

### The settlement document

Every input to the document is in its path: the reputation registry (CAIP-10), the
agentId, the rater (the publisher's address, ERC-8004's `clientAddress`), the escrow
(CAIP-10) and the deal id. The server derives the rest from indexed chain events, so the
bytes are the same for every reader and can be pinned. It carries the ERC-8004 feedback
file fields (`agentRegistry`, `agentId`, `clientAddress`, `createdAt`, `value`,
`valueDecimals`, `tag1`, `tag2`) plus `settlement: { chainId, contract, dealId }`, the
seller as `subject`, and a link to the wallet card. Schema:
[`schemas/settlement-feedback.schema.json`](../../schemas/settlement-feedback.schema.json),
served at `/schemas/settlement-feedback.schema.json`.

Any escrow can emit the same field. The reader verifies it against whatever settlement
events are indexed; Sinetti Escrow is the first.

### Why slashing and refund share a value

One signed number cannot carry three outcomes without loss, so the loss is placed
deliberately: the number answers "did the seller get paid", and `tag1` carries which
failure it was. A negative value for slashing would invent a scale convention nobody else
reads. Staying inside 0–100 keeps a naive average interpretable.

## The agentId problem

`giveFeedback` takes a `uint256 agentId`. The Identity Registry is an ERC-721 whose token
ids are assigned incrementally, with no reverse index from wallet to agentId. Sinetti
indexes wallets, so the mapping is supplied (`--agent-ids 0xSELLER=42`) and verified before
anything is written: `checkAgentId` reads `getAgentWallet` and `ownerOf` and refuses unless
one of them is the subject. Publishing against a wrong agentId writes a permanent entry
against an unrelated agent.

"The feedback submitter MUST NOT be the agent owner or an approved operator for agentId."
The publisher checks this locally and refuses, rather than paying gas for a revert.

## Idempotency

ERC-8004 is append-only with no merge and no edit, only `revokeFeedback` by the original
client. The `erc8004_publications` table is the guard, keyed by registry and deal. A row
is reserved before each send; a crash after broadcast leaves the reservation in place and
the deal out of every later plan until the operator reconciles it against the chain.

## Running it

```
ERC8004_RPC_URL_ETHEREUM_SEPOLIA=… ERC8004_PRIVATE_KEY=… \
  npm run publish8004 -- --registry ethereum-sepolia --agent-ids 0xSELLER=42 --limit 1
```

Without `--confirm` this prints the plan and the binding checks and writes nothing. The
key must be present even for the dry run, because the signer's address is part of every
document URI. `ERC8004_PRIVATE_KEY` is read in one module and nowhere else; a test asserts
the reader, indexer, API and web surface never import it, transitively.

## Not done here

This repository publishes nothing on its own; the operator ran the publisher for the
settled Sepolia deals, and they verify under the reader. Publishing needs a funded key on the target
chain, a seller registered in the Identity Registry by itself (Sinetti registering on its
behalf would make Sinetti the owner, and the spec then forbids the feedback), and the
operator's authorisation for the write. The code, the mocks, and an end-to-end test
against a local chain exist: the test deploys both registries, registers an agent,
publishes a settled deal, reads the emitted `feedbackURI`, and, in the reader's test, rates
an agent from a counterparty wallet and verifies the entry end to end.
