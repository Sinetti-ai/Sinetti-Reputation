# A2A agent-card extension: Sinetti recourse

**Extension URI:** `https://rep.sinetti.ai/ext/sinetti-recourse/v1`
**Status:** draft, v1 · **A2A:** v1.0.0 · **Params schema:** [`a2a-recourse-extension.schema.json`](../../schemas/a2a-recourse-extension.schema.json)

## What it declares

That an A2A agent trades under Sinetti escrow and recourse, and where to read its
operator-computed reputation record. A buying agent that reads agent cards at
discovery time can tell, before it commits to anything, that this seller's funds
sit in a non-custodial hold, release against recorded acceptance criteria, and go
to Sinetti recourse when delivery is disputed.

That is the whole claim. It is not an identity assertion, and it is not a
guarantee of delivery quality. The Sinetti design brief keeps those separate on purpose:
the Seal "deliberately does not mean 'this agent is identified'".

## Why an extension and not a new standard

A2A's `AgentCapabilities.extensions` is an open list. Adding an entry needs no
permission, no registration, and no A2A spec change — the field exists precisely
so third parties can attach their own semantics. Cost is one URI and a params
object. This is the cheapest available expression of spec §2's "interoperability
over invention", and it is the only one of Sinetti's standards paths that
requires nothing from anybody else.

## Placement

```json
{
  "capabilities": {
    "extensions": [
      {
        "uri": "https://rep.sinetti.ai/ext/sinetti-recourse/v1",
        "description": "This agent settles through Sinetti escrow: ...",
        "required": false,
        "params": { "wallet": "0x…", "card": "https://rep.sinetti.ai/agents/0x…", "…": "…" }
      }
    ]
  }
}
```

`AgentExtension` is defined in [`specification/a2a.proto`](https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto)
as `{ uri, description, required, params }`, and `params` is a
`google.protobuf.Struct` — an arbitrary JSON object. Nothing below changes A2A;
it only says what Sinetti puts in that object.

## `required` is always false

A2A defines `required: true` as "the client must understand and comply with the
extension's requirements". Setting it would mean a buyer that has never heard of
Sinetti must refuse the seller. That inverts the point: the extension exists to
make extra assurance visible to buyers who check, not to shut out buyers who do
not. `buildRecourseExtension` in [`src/standards.ts`](../../src/standards.ts)
hard-codes `false`, and a test holds it there.

## Params

| Field | Meaning |
|---|---|
| `wallet` | The settlement address the reputation is about. |
| `card` | The authoritative card. Public, unauthenticated, thin to anonymous callers. |
| `cardSchema` | JSON Schema the full card validates against. |
| `escrows` | CAIP-10 ids of the escrow deployments feeding the card. A deal settled anywhere else is not in it. |
| `observed` | A stale-able hint (`trustTier`, `dealsSettled`, `asOf`), or `null` when the wallet has no settled history. |

### The trust model, stated plainly

**Everything in an agent card is written by the agent that publishes the card.**
Sinetti does not host the seller's card and cannot stop a seller from writing a
flattering `observed` block, a `wallet` it does not control, or a `card` URL
pointing somewhere else entirely.

So a consumer MUST:

1. Fetch `params.card` over TLS from a host it independently trusts.
2. Check the card's `address` equals `params.wallet`.
3. Read the card, not `observed`. `observed` is a display hint for humans
   skimming a card, and it is the field an adversary edits first.

Step 2 is the one that gets skipped. Without it a seller can point at a
high-reputation stranger's card and inherit their record for free.

`observed` is `null`, never zeroed, for a wallet with no settled history —
"we have no record of this agent" and "this agent has a clean record of zero
deals" are different claims, and collapsing them would let a brand-new wallet
present as an established one with an unblemished score.

## Activation

A2A clients signal which extensions they intend to use with an
`X-A2A-Extensions` request header carrying the URIs. Sinetti's extension needs
no activation to be *useful* — it is a static declaration a buyer reads off the
card at discovery — but a client that will act on it should send the header, and
a Sinetti-aware seller can use its presence to decide whether to attach
deal-specific detail.

x402's own A2A transport (`specs/transports-v2/a2a.md` in `coinbase/x402`)
declares itself the same way, at `https://github.com/google-a2a/a2a-x402/v0.1`,
with `required: true` — correct for a payment extension, where a client that
cannot pay cannot transact, and wrong for an assurance signal. **A seller can
carry both entries on one card today**, which is the cheapest x402 adjacency
available; see the protocol registry entry for x402 at https://sinetti.ai/registry.html.

## Generating an entry

```
GET https://rep.sinetti.ai/ext/sinetti-recourse/v1/for/{address}
```

Returns the complete `AgentExtension` object, ready to paste. Unauthenticated by
design: a seller must be able to build its own entry without a Sinetti session,
and a buyer must be able to regenerate the entry and diff it against what the
seller actually published. That diff is the cheapest available forgery check.

The extension URI itself resolves to a JSON descriptor naming the params schema,
the escrow deployments, and the trust model above.

## What this does not do

It does not put anything on-chain, and a buyer acting on it is trusting Sinetti's
hosted card and the seller's honesty about `wallet`. The on-chain expression of
the same record is the ERC-8004 path — see
[`erc-8004-publishing.md`](erc-8004-publishing.md) — which is slower, costs gas,
and is bounded by what that registry stores.

## Open

- **Nobody carries it yet.** The extension is defined, hosted and generable; it
  is on no real seller's agent card, because Sinetti operates no seller agent.
  Getting one live needs a pilot seller, not more code.
- **Card signatures.** A2A `AgentCardSignature` (JWS) would let a seller prove
  its card was not tampered with in transit. It does not help here: the seller
  signs its own claims either way, so a signed card with a forged `wallet` is
  still forged. The check that matters stays step 2 above.
