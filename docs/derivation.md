# Card derivation

Every figure on a reputation card is computed from public escrow events by the
rules below. Same chain, same escrow address, same indexer version, same wallet,
same card. This document is the rule book; `src/aggregator.ts` implements it and
`test/aggregator*.test.ts` pin the cases. If the two disagree, this document is
wrong or the code is, and either way it is a bug.

## Inputs

The indexer reads seven SinettiEscrowV04 events and nothing else: `DealOpened`,
`DealParties`, `BondPosted`, `BondSlashed`, `Challenged`,
`VerificationRecorded`, `Settled` (the ABI in `src/abi.ts` is the exact list). Pause, evidence and withdrawal events carry
nothing a card depends on. Events are grouped by deal id, ordered by block and
log index. Nothing off-chain is an input: there is no account table, no declared
wallet links, no operator-held list of who is who. The one operator input is the
pair of address lists `OPERATOR_VERIFIER_ADDRESSES` and
`OPERATOR_ARBITER_ADDRESSES`, which affects only the `provenance` split below
and is published by whoever runs an instance.

## Which deals count

A deal counts once it has a `Settled` event whose `reason` maps to a release or
a refund. `reason` is an indexed `bytes32` holding readable ASCII.

| `Settled.reason` | Outcome |
| --- | --- |
| `accepted` | release |
| `verdict_pass` | release |
| `ruling_release` | release |
| `verdict_fail` | refund |
| `verdict_inconclusive` | refund |
| `ruling_refund` | refund |
| `timeout` | refund |
| `ruling_lapsed` | the verifier's standing verdict: `VerificationRecorded.verdict` equal to 1 (Pass) is a release, anything else a refund; no recorded verdict makes the deal unclassifiable |
| `cancelled` | not counted: a settlement that is neither release nor refund |
| anything else | not counted |

A deal with no `Settled` event, or a reason outside this table, contributes
nothing to any card. Unknown stays unknown on the card.

## Outcomes

Three buckets: `release`, `refund`, `refund_and_slash`. A refund is
`refund_and_slash` only when the deal also has a `BondSlashed` event. The
reason `ruling_refund` alone does not imply a slash, because a deal that never
posted a bond has nothing to slash.

`deals_settled` is the sum of the three buckets.

## Rates

All over `deals_settled`, and 0 when it is 0.

- `success_rate`: releases.
- `dispute_rate`: deals with a `Challenged` event.
- `timeout_rate`: deals whose reason is `timeout`.

## Roles

`as_buyer` and `as_seller` count the settled deals in which the wallet held
that role. A wallet is attributed a deal if it appears as buyer, seller,
verifier or arbitrator.

## Bonds

Counted for the wallet's seller role only.

- `posted_count`: deals with a `BondPosted` event.
- `slashed_count`: deals with a `BondSlashed` event.
- `returned_count`: deals where a bond was posted and the reason is anything
  other than `ruling_refund`. The rule is positive on purpose: V04 has no
  bond-returned event, and reasoning from the absence of `BondSlashed` would
  turn a dropped log into a returned bond.

## Counterparties and the graph

A wallet is its own identity. Nothing merges two wallets.

- `distinct_counterparties`: the number of other wallets that took any role in
  the wallet's settled deals.
- `independent_counterparty_share`: the fraction of those counterparties that
  have at least one settled deal with some wallet outside the subject's cluster
  (the subject plus all of its counterparties). A counterparty that only ever
  trades inside the cluster is not independent. 0 when there are no
  counterparties.
- `repeat_counterparty`: true when any single counterparty appears in two or
  more of the wallet's settled deals.

These fields raise the cost of farming a clean record with a ring of
cooperating wallets. They do not detect a ring that also trades outside itself.
Identifying wallets that belong to one real-world actor is out of scope here.

## Trust tier

- `reputation_bearing`: at least 5 settled deals and an independent share of at
  least 0.5.
- `accountable`: at least one counterparty and an independent share above 0.
- `unverified`: everything else, including a wallet with no settled deals,
  which has no card at all.

The two thresholds are first-pass judgment calls, stated in the code as
constants, to be tuned when observed data exists. Changing them is a card
change and belongs in the changelog.

## Provenance

`operator_verified` counts settled deals whose verifier or arbitrator address is
in the running instance's operator lists; `self_adjudicated` is the rest. Two
instances with different operator lists produce different splits and are both
correct about their own operators. Everything else on the card is instance
independent.

## Identity anchor

`buyerIdentityRef` and `sellerIdentityRef` from `DealOpened` are opaque values
the parties chose to sign. For the wallet's own side of each settled deal, an
unset reference counts toward `deals_without_anchor`; a set one counts toward
`deals_with_anchor` and is listed in `anchors`, sorted, deduplicated. Several
anchors is a fact the card reports; the card does not pick one. An empty
`anchors` list with a non-zero `deals_without_anchor` means no deal filled the
slot; it does not mean an identity failed to verify. Every deal opened so far on the
Sepolia deployment carries zero in both slots, so cards read as having no anchor until
an escrow populates them.

## What is withheld

`settled_volume` (total amount, one token) is computed and stripped from every
response, to limit financial profiling of a wallet from a public endpoint. Cards
carry no transaction lists and no per-deal rows. `started_at` is the funding
time of the wallet's earliest deal.

## ERC-8004 identity: declared by the agent

The directory reads two documents per agent and derives nothing from them. The
registration file behind `agentURI` gives name, description, `active`,
`services` (an `A2A` agent card URL, an `MCP` endpoint, and others) and
`registrations`; the A2A agent card behind the `A2A` service gives skills,
capabilities, security scheme names and whether `signatures` are present.
Neither document has an on-chain hash, both can change at any time, and both
are the agent describing itself. They are fetched under the feedback rules
(https, ipfs or inline data URI, 64 KB, no redirects, no private hosts), stored with the time of
reading, re-read after a day or when `URIUpdated` fires, and shown under
"declared by the agent". Nothing in them reaches `verified_score`, the verified
count, or the directory order, which sorts by verified ratings alone.

Three consistency checks are shown as flags and change no figure:
`registrations_missing` when the file's `registrations` does not name the
agentId it hangs off on this registry; `card_host_mismatch` when the agent
card's own `url` is on a different host from the declared A2A endpoint;
`legacy_endpoints_key` when the file uses the pre-spec `endpoints` key.

A verified rating may name A2A `skills` and a `taskId` in its feedback file.
They are shown beside the entry and matched to the card's skill ids; an id the
card does not list is marked. Whether the skill was delivered is the settled
deal's business, which is what the rating verified against.

## ERC-8004 feedback verification

The reader treats every `NewFeedback` event on a Reputation Registry as a claim
and decides, from public data alone, whether the claim can be checked. Rules,
in order; the first failure ends the check and the entry stays `unverified`.

1. **Fetch.** `feedbackURI` must be `https:`, `ipfs:` (resolved through the
   configured gateway) or an inline `data:` URI with a JSON media type, which
   is decoded and fetches nothing. An empty URI is `no_uri`. URLs with credentials, hosts that are loopback, link
   local, private, carrier grade NAT, multicast, `.local`, `.internal` or
   `localhost`, and bodies over 64 KB are refused. A non-2xx response or a
   network failure is `unreachable`.
2. **Hash.** When the on-chain `feedbackHash` is non-zero, keccak-256 of the
   body must equal it. A zero hash means the rater pinned nothing and the body
   is taken as fetched.
3. **Parse.** The body must be a JSON object. Its `settlement` field must be an
   object with a positive integer `chainId`, an address `contract`, and a
   decimal string `dealId`.
4. **Settled.** A deal with that chain, contract and id must be indexed and have
   a `Settled` reason that maps to a release or refund under the table above. A
   cancelled, unsettled or unknown deal fails.
5. **Parties.** The event's `clientAddress` must be the deal's buyer or seller.
   The agent's bound addresses are its declared `agentWallet` and the owner of
   its token in the Identity Registry; one of them must be the other party and
   neither may be the rater. A deal with one address on both sides fails.

An entry that passes is `verification: settlement` and carries the evidence:
deployment, chain, contract, deal id, outcome, the rater's role, the agent's
matched address and the settlement time. Revocation is tracked from
`FeedbackRevoked`; a revoked entry stays in the count and leaves the score.

One settled deal backs one rating per rater. When the same rater cites the
same deal in several entries, the earliest is verified and the rest count as
`duplicates`.

Per agent: `feedback.total` is every entry, `revoked`, `unchecked` and
`duplicates` are subsets, `verified` is unrevoked, deduplicated entries that
passed. `verified_score` is the mean of those entries'
`value / 10^valueDecimals`, `null` with none.
`verified_clients` is their distinct `clientAddress` set, sorted, which is the
`clientAddresses` argument the registry's own `getSummary` takes. Nothing from
an unverified entry reaches any figure but the counts.

Each entry is checked once and the result is recorded with a timestamp. An
`unreachable` file is tried again after a day. Every other result stands until
an operator runs `npm run feedback -- <registry> --recheck`, or calls
`recheckFeedback` for one agent, for example after it changes its declared
wallet; the check then re-runs over the same public inputs.

## Reproducing a card

```sh
npm ci
SEPOLIA_RPC_URL=<any Sepolia JSON-RPC endpoint> npm run index -- sepolia
npm run api
curl http://127.0.0.1:3000/agents/<address>
```

The result must match any other instance at the same indexer version, except
for `provenance` when operator lists differ.
A scan is complete only when it prints `missing: 0`; public RPCs sometimes answer a
populated log window with an empty list, and the scans re-ask and repair sequence
holes but report what they could not recover.
