# Changelog

Human-readable summary of each release. The complete list of changes is in the
Git history and the GitHub release notes.

## Unreleased

The public repository is the reader: registry scans, the escrow settlement reader,
feedback verification, the publisher, the read-only API and `llms.txt`. The per-wallet
card (outcomes, rates, bonds, trust tier, counterparty graph, provenance, identity
anchor), the A2A recourse extension and the HTML pages are served by the hosted instance
through `createApp(db, extend)` and are not part of this repository. Settlement resolution
moved to `src/settlement.ts`; `GET /health` returns status only.

Indexers survive public RPCs that answer populated `eth_getLogs` windows with an
empty list: empty windows are re-asked, and the identity and feedback scans repair
holes in their sequences (agent ids from 0, feedback indexes from 1 per rater and
agent, escrow deal ids and unsettled deals) by indexed topic, reporting `repaired`
and `missing`; `GET /registries` carries the missing counts, held for a minute
between recounts. The mock reputation registry now numbers feedback from 1 like
the reference contract.

The publisher's local self-feedback check reads token and operator approvals as
well as ownership, matching the rule the registry enforces. A recheck clears the
old verdict with the status. The default fetcher resolves a host and refuses a
name that answers with a private address; `https` URIs on a non-default port are
refused. The settlement time in evidence and in published feedback documents is
the `Settled` log's block time. `GET /registries/:name/agents` is paged like the
directory. Schema and `llms.txt` are read once from the repository root.

ERC-8004 directory: index `Registered` and `URIUpdated` from the reference identity
registries, fetch each agent's registration file and A2A agent card under the
reader's fetch rules (eight in flight, re-read daily or on URI change), and show
the declared name, description, services, skills, capabilities and signature
presence on the agent card beside its ratings, marked as unchecked. Verified
entries show the A2A `skills` and `taskId` the rater named, matched to the
card's skill list. Flags for a file that does not name its agentId, a card whose
url is on another host, and the legacy `endpoints` key. Name search (`/search`,
`/registries/:name/search`) and a paged directory (`/registries/:name/directory`,
`/r/:registry`). `npm run identity -- <registry>`. Identity creation blocks added
to registry configuration.

ERC-8004 reader: index `NewFeedback` and `FeedbackRevoked` from the reference
registries (Ethereum Sepolia, Base Sepolia, Ethereum, Base), fetch each entry's
feedback file under fetch rules (https or ipfs, 64 KB cap, keccak check against
`feedbackHash`, private hosts refused), verify `settlement` claims against
indexed escrow deals, and serve per-agent cards at `/registries/:name/agents/:id`
with verified count, verified score and the verified client list.
`npm run feedback -- <registry>`.
Publisher now points each entry at a per-deal settlement document
(`/feedback/…`) pinned by a real `feedbackHash`, so Sinetti's own ratings verify
under the reader; `planPublication` takes the publisher address. Registry
configuration moved to `src/registries.ts`, addresses updated to the
erc-8004-contracts reference deployments and verified on chain. A rating from
the agent's own bound address never verifies; one deal verifies one rating per
rater; unreachable files retry after a day and `--recheck` resets a registry.

First public source tree, carved out of a private repository with fresh history.
Indexer for SinettiEscrowV04 settlement events, SQLite persistence, read-only
JSON API, JSON Schema validation, ERC-8004 publishing plan, Hardhat integration
tests against a mock escrow fixture. Configured for the v0.1.0 Sepolia escrow
`0x73862690E12621b3BC5749281CE4b23fe4a1695c`. No release has been tagged.
