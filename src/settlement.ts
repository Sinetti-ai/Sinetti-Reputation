/**
 * Settlement, as the reader and the publisher both need it: which deals reached a
 * terminal outcome, and as what. One definition, so a rating checked by the reader and
 * a rating written by the publisher agree on what "settled" means.
 */
import { decodeBytes32String, getAddress } from "ethers";

import { SinettiDatabase, StoredDeal } from "./db";

export type Resolution = "release" | "refund" | "refund_and_slash";

export interface DealEvent {
  event_name: string;
  args: Record<string, unknown>;
  block_timestamp?: number;
}

/**
 * V04 settles every path with one `Settled`, and puts the outcome in its
 * `reason` rather than in which event fired. Nine values, decoded from an
 * indexed `bytes32` that holds readable ASCII rather than a hash.
 *
 * See docs/derivation.md, "Settlement reasons".
 */
const V04_REASON_OUTCOME = new Map<string, "release" | "refund" | "cancelled" | "verdict">([
  ["accepted", "release"],
  ["verdict_pass", "release"],
  ["ruling_release", "release"],
  ["verdict_fail", "refund"],
  ["verdict_inconclusive", "refund"],
  ["ruling_refund", "refund"],
  ["timeout", "refund"],
  ["cancelled", "cancelled"],
  // The one reason that cannot be resolved from itself: the arbitrator stayed
  // silent, so the deal falls back to the verifier's standing verdict.
  ["ruling_lapsed", "verdict"]
]);

/** Verdict ordinals of SinettiEscrowV04.Verdict: 0 None, 1 Pass, 2 Fail, 3 Inconclusive. */
const VERDICT_PASS = "1";

/**
 * Reads `Settled.reason`, which V04 stores as readable ASCII in an indexed
 * bytes32 rather than as a hash. Trailing NULs are padding.
 */
export function settledReason(events: DealEvent[]): string | null {
  const settled = events.find((event) => event.event_name === "Settled");
  if (!settled) return null;
  const raw = String(settled.args.reason ?? "");
  try {
    return decodeBytes32String(raw);
  } catch {
    // A reason outside the nine-value vocabulary is not something to guess at.
    return null;
  }
}

function classifyV04(events: DealEvent[]): Resolution | null {
  const reason = settledReason(events);
  if (!reason) return null;
  const outcome = V04_REASON_OUTCOME.get(reason);
  if (!outcome) return null;
  // Cancelled is a terminal state V02 never had. It is a settlement, but not a
  // release or a refund, and counting it as either would misreport both parties.
  if (outcome === "cancelled") return null;

  let resolved: "release" | "refund";
  if (outcome === "verdict") {
    const verdict = events.find((event) => event.event_name === "VerificationRecorded");
    // ruling_lapsed with no recorded verdict cannot happen, because the challenge
    // that opens a ruling window is only reachable from Verified, but the deal is
    // unclassifiable rather than assumable if the row is missing.
    if (!verdict) return null;
    resolved = String(verdict.args.verdict) === VERDICT_PASS ? "release" : "refund";
  } else {
    resolved = outcome;
  }

  if (resolved === "release") return "release";
  // ruling_refund is the only V04 path that slashes, and only when a bond was
  // actually in custody. Anchor on BondSlashed rather than on the reason alone,
  // so a refund of a deal that never posted a bond is not reported as a slash.
  return events.some((event) => event.event_name === "BondSlashed") ? "refund_and_slash" : "refund";
}

export function classifyOutcome(events: DealEvent[]): Resolution | null {
  return classifyV04(events);
}

/** A deal that ended on a deadline rather than a decision. */
export function isTimeout(events: DealEvent[]): boolean {
  return settledReason(events) === "timeout";
}

/**
 * V04 has no returned-bond event: `_release` and `_refund` both fold the bond
 * into a `Settled` credit, so it has to be derived.
 *
 * The rule is positive on purpose: a bond was posted, and the settlement was
 * not the one path that slashes. The obvious alternative ("no BondSlashed was
 * seen") gives the same answer on well-formed data and the wrong one on
 * incomplete data: an unmatched log is dropped silently, so a missing filter arm
 * or a reorg would flip a slashed bond to returned. Reasoning from presence
 * fails to *missing*; reasoning from absence fails to *wrong*.
 *
 * See docs/derivation.md, "Bonds".
 */
export function bondReturned(events: DealEvent[], bondPosted: boolean): boolean {
  if (!bondPosted) return false;
  const reason = settledReason(events);
  return reason !== null && reason !== "ruling_refund";
}

export function getEvents(db: SinettiDatabase, deployment: string, contract: string, dealId: string): DealEvent[] {
  const rows = db.prepare(`
    SELECT event_name, args_json, block_timestamp FROM raw_events
    WHERE deployment = ? AND contract = ? AND deal_id = ? ORDER BY block_number, log_index
  `).all(deployment, getAddress(contract), dealId) as Array<{ event_name: string; args_json: string; block_timestamp: number }>;
  return rows.map((row) => ({ event_name: row.event_name, args: JSON.parse(row.args_json), block_timestamp: row.block_timestamp }));
}

export type ResolvedDealVisitor = (deal: StoredDeal, events: DealEvent[], resolution: Resolution) => void;

export function walkResolvedDeals(
  db: SinettiDatabase,
  deals: StoredDeal[],
  visitor?: ResolvedDealVisitor
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();

  for (const deal of deals) {
    const events = getEvents(db, deal.deployment, deal.contract, deal.deal_id);
    const resolution = classifyOutcome(events);
    if (!resolution) continue;

    const participants = new Set(
      [deal.buyer, deal.seller, deal.arbiter, deal.verifier].map((address) => address.toLowerCase())
    );
    for (const participant of participants) {
      const counterparties = graph.get(participant) ?? new Set<string>();
      for (const other of participants) {
        if (other !== participant) counterparties.add(other);
      }
      graph.set(participant, counterparties);
    }
    visitor?.(deal, events, resolution);
  }

  return graph;
}

export interface SettledDeal {
  deal: StoredDeal;
  resolution: Resolution;
  settled_at: number;
}

/**
 * Every deal that reached a terminal outcome, oldest first.
 *
 * Exported for the ERC-8004 publisher, which needs deals one at a time rather
 * than as an aggregate. It goes through `walkResolvedDeals` rather than reading
 * `raw_events` itself so that "what counts as settled, and as what outcome"
 * stays a single definition. A publisher with its own copy of that logic would
 * drift from the cards, and the drift would be invisible: the card and the
 * on-chain record would simply disagree, with nothing failing.
 */
export function listSettledDeals(db: SinettiDatabase): SettledDeal[] {
  const deals = db.prepare(
    "SELECT * FROM deals ORDER BY funded_at, deployment, contract, CAST(deal_id AS INTEGER)"
  ).all() as StoredDeal[];
  const settled: SettledDeal[] = [];
  walkResolvedDeals(db, deals, (deal, events, resolution) => {
    settled.push({ deal, resolution, settled_at: settledAtOf(deal, events) });
  });
  return settled;
}

/**
 * One deal by chain, escrow and id, with its outcome, or null if it is not
 * indexed or has not settled. The ERC-8004 reader uses this to check a rater's
 * settlement claim against the same definition of "settled" the cards use.
 */
export function resolveDeal(
  db: SinettiDatabase,
  chainId: number,
  contract: string,
  dealId: string
): { deal: StoredDeal; resolution: Resolution; settledAt: number } | null {
  const deal = db.prepare("SELECT * FROM deals WHERE chain_id = ? AND contract = ? AND deal_id = ?")
    .get(chainId, getAddress(contract), dealId) as StoredDeal | undefined;
  if (!deal) return null;
  const events = getEvents(db, deal.deployment, deal.contract, deal.deal_id);
  const resolution = classifyOutcome(events);
  if (!resolution) return null;
  return { deal, resolution, settledAt: settledAtOf(deal, events) };
}

/**
 * The block time of the `Settled` log. block_timestamp is optional on DealEvent;
 * a deal whose log lacks one falls back to the latest timestamp among its events,
 * then to funding time, rather than being dropped or dated at epoch zero. The
 * value is part of the hash-pinned published feedback document, so it must not
 * move when a later scan adds an event.
 */
function settledAtOf(deal: StoredDeal, events: DealEvent[]): number {
  const settled = events.find((event) => event.event_name === "Settled")?.block_timestamp;
  if (typeof settled === "number") return settled;
  const timestamps = events.map((event) => event.block_timestamp).filter((t): t is number => typeof t === "number");
  return Math.max(deal.funded_at, ...timestamps);
}
