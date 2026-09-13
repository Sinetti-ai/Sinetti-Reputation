# Derivation rules

Every figure this reader serves is computed from public chain events and the public
documents they point at, by the rules below. Same chain, same indexer version, same
inputs, same figures. This document is the rule book; `src/settlement.ts`,
`src/feedback.ts` and `src/identity.ts` implement it and the tests pin the cases. If the
two disagree, this document is wrong or the code is, and either way it is a bug.

A hosted instance may derive more from the same settled deals, such as a per-wallet card;
those derivations are that instance's, and are documented where they are served.

## Inputs

The indexer reads seven SinettiEscrowV04 events and nothing else: `DealOpened`,
`DealParties`, `BondPosted`, `BondSlashed`, `Challenged`,
`VerificationRecorded`, `Settled` (the ABI in `src/abi.ts` is the exact list). Pause, evidence and withdrawal events carry
nothing a card depends on. Events are grouped by deal id, ordered by block and
log index. Nothing off-chain is an input: there is no account table, no declared
wallet links, no operator-held list of who is who.

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

1. **Fetch.** `feedbackURI` must be `https:` on the default port, `ipfs:`
   (resolved through the configured gateway) or an inline `data:` URI with a
   JSON or plain-text media type, which is decoded and fetches nothing. An
   empty URI is `no_uri`. URLs with credentials, hosts that are loopback, link
   local, private, carrier grade NAT, multicast, `.local`, `.internal` or
   `localhost`, and bodies over 64 KB are refused; redirects are not followed.
   The default fetcher resolves the host first and refuses a name whose answer
   includes such an address. A non-2xx response or a network failure is
   `unreachable`.
2. **Hash.** When the on-chain `feedbackHash` is non-zero, keccak-256 of the
   body must equal it. A zero hash means the rater pinned nothing and the body
   is taken as fetched, so such an entry is reproducible only against the
   document as it stood when read.
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
matched address and the block time of the `Settled` log. Revocation is tracked from
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

## Reproducing a figure

```sh
npm ci
SEPOLIA_RPC_URL=<Sepolia JSON-RPC> ERC8004_RPC_URL_ETHEREUM_SEPOLIA=<Sepolia JSON-RPC> \
  sh -c 'npm run index -- sepolia && npm run identity -- ethereum-sepolia && npm run feedback -- ethereum-sepolia'
npm run api
curl http://127.0.0.1:3000/registries/ethereum-sepolia/agents/<agentId>
```

The result must match any other instance at the same indexer version, with two
qualifications. Public RPCs sometimes answer a populated log window with an empty
list. Every scan re-asks empty windows. The identity and feedback scans then re-ask
holes inside the id sequences they know and print `missing`, the holes they could
not fill; ids above the highest one seen are outside that count. The escrow scan
re-asks deal-id holes and deals with no `Settled` log and prints `repaired`. The
first sight of a `Settled` log costs one more question, the whole deal by its id
from opening to settlement, so an earlier log the window dropped (a `BondSlashed`,
a `VerificationRecorded`) is fetched before the outcome is read; an answer that
lacks the `Settled` log already seen is refused, and the deal stays unsettled until
a later answer holds it. Every repair is bounded by the RPC eventually answering a
single-deal filter in full. The second qualification is rule 2: an entry with a
zero `feedbackHash` is checked against a document that can change.
