import { decodeBytes32String, formatUnits, getAddress } from "ethers";

import { SinettiDatabase, StoredDeal } from "./db";
import { isUnset } from "./identityanchor";
import { isOperatorAddress, loadOperatorConfig, OperatorConfig } from "./operators";

export type Resolution = "release" | "refund" | "refund_and_slash";

export interface DealEvent {
  event_name: string;
  args: Record<string, unknown>;
  block_timestamp?: number;
}

export interface ReputationCard {
  address: string;
  started_at: string;
  deals_settled: number;
  outcomes: Record<Resolution, number>;
  rates: { success_rate: number; dispute_rate: number; timeout_rate: number };
  bonds: { posted_count: number; slashed_count: number; returned_count: number };
  roles: { as_buyer: number; as_seller: number };
  repeat_counterparty: boolean;
  graph: { distinct_counterparties: number; independent_counterparty_share: number };
  provenance: { operator_verified: number; self_adjudicated: number };
  trust_tier: "unverified" | "accountable" | "reputation_bearing";
  /**
   * Whether this wallet's settled deals carry a recorded legal identity.
   *
   * Distinct anchors rather than one "current" identity: a wallet has many
   * deals and nothing forces them to agree, so reporting a single value would
   * assert a stability the data does not have. Two anchors is a fact a buyer
   * should see, not one this card should pick a winner from.
   *
   * `anchors: []` with a non-zero `deals_without_anchor` is the honest reading
   * of today's chain: the escrow has the slot and no deal has ever filled it.
   * It must not be reported as an identity that failed to verify.
   */
  identity_anchor: {
    anchors: string[];
    deals_with_anchor: number;
    deals_without_anchor: number;
  };
  settled_volume?: { amount: string; token: string; human: string };
}

// First-pass judgment-call thresholds; tune once observed reputation data is available.
const REPUTATION_BEARING_MIN_DEALS = 5;
const REPUTATION_BEARING_MIN_INDEPENDENT_SHARE = 0.5;
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
 * bytes32 rather than as a hash. Trailing NULs are the padding, not content.
 */
function settledReason(events: DealEvent[]): string | null {
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
    // ruling_lapsed with no recorded verdict cannot happen — the challenge that
    // opens a ruling window is only reachable from Verified — but the deal is
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
function isTimeout(events: DealEvent[]): boolean {
  return settledReason(events) === "timeout";
}

/**
 * V04 has no returned-bond event: `_release` and `_refund` both fold the bond
 * into a `Settled` credit, so it has to be derived.
 *
 * The rule is positive on purpose — a bond was posted, and the settlement was
 * not the one path that slashes. The obvious alternative ("no BondSlashed was
 * seen") gives the same answer on well-formed data and the wrong one on
 * incomplete data: an unmatched log is dropped silently, so a missing filter arm
 * or a reorg would flip a slashed bond to returned. Reasoning from presence
 * fails to *missing*; reasoning from absence fails to *wrong*.
 *
 * See docs/derivation.md, "Bonds".
 */
function bondReturned(events: DealEvent[], bondPosted: boolean): boolean {
  if (!bondPosted) return false;
  const reason = settledReason(events);
  return reason !== null && reason !== "ruling_refund";
}

function getEvents(db: SinettiDatabase, deployment: string, contract: string, dealId: string): DealEvent[] {
  const rows = db.prepare(`
    SELECT event_name, args_json, block_timestamp FROM raw_events
    WHERE deployment = ? AND contract = ? AND deal_id = ? ORDER BY block_number, log_index
  `).all(deployment, getAddress(contract), dealId) as Array<{ event_name: string; args_json: string; block_timestamp: number }>;
  return rows.map((row) => ({ event_name: row.event_name, args: JSON.parse(row.args_json), block_timestamp: row.block_timestamp }));
}

function involved(deal: StoredDeal, walletSet: Set<string>): boolean {
  return [deal.buyer, deal.seller, deal.arbiter, deal.verifier]
    .some((role) => walletSet.has(role.toLowerCase()));
}

type ResolvedDealVisitor = (deal: StoredDeal, events: DealEvent[], resolution: Resolution) => void;

function walkResolvedDeals(
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

export function computeCounterpartyGraph(db: SinettiDatabase): Map<string, Set<string>> {
  const deals = db.prepare("SELECT * FROM deals ORDER BY funded_at, deployment, contract, CAST(deal_id AS INTEGER)").all() as StoredDeal[];
  return walkResolvedDeals(db, deals);
}

/**
 * A wallet is its own identity.
 *
 * The card is computed from chain data alone, so that every reader recomputes
 * the same figures from the same chain — a private table of declared wallet
 * links would be an input nobody else holds, and the card would stop being
 * reproducible. An agent that wants two wallets read as one entity says so on
 * its own ERC-8004 / A2A registration, which every reader can see.
 *
 * The declared-link resolver this replaces never bounded the attack it was
 * built for either: linking was voluntary, so a wash trader simply did not
 * link. Undeclared-sybil detection is out of scope for this repo.
 */
function identityOf(walletLower: string): string {
  return walletLower;
}

function roleOperatorConfigs(config: OperatorConfig): { verifier: OperatorConfig; arbiter: OperatorConfig } {
  return {
    verifier: { verifierAddresses: config.verifierAddresses, arbiterAddresses: [] },
    arbiter: { verifierAddresses: [], arbiterAddresses: config.arbiterAddresses }
  };
}

function aggregateForWalletSet(
  db: SinettiDatabase,
  walletSet: Set<string>,
  displayAddress: string
): ReputationCard | null {
  const allDeals = db.prepare("SELECT * FROM deals ORDER BY funded_at, deployment, contract, CAST(deal_id AS INTEGER)").all() as StoredDeal[];
  const relevant = allDeals.filter((deal) => involved(deal, walletSet));
  if (relevant.length === 0) return null;

  const outcomes: Record<Resolution, number> = { release: 0, refund: 0, refund_and_slash: 0 };
  let disputes = 0;
  let timeouts = 0;
  let posted = 0;
  let slashed = 0;
  let returned = 0;
  let asBuyer = 0;
  let asSeller = 0;
  let operatorVerified = 0;
  const counterparties = new Set<string>();
  const counterpartyDealCounts = new Map<string, number>();
  const identityAnchors = new Set<string>();
  let dealsWithAnchor = 0;
  let dealsWithoutAnchor = 0;
  const settledTokens = new Set<string>();
  let hasUnknownTokenDecimals = false;
  const volumes = new Map<string, { raw: bigint; decimals: number; token: string }>();
  const operatorConfigs = roleOperatorConfigs(loadOperatorConfig());
  const identity = identityOf;

  const counterpartyGraph = walkResolvedDeals(db, allDeals, (deal, events, resolution) => {
    if (!involved(deal, walletSet)) return;
    outcomes[resolution]++;
    if (events.some((event) => event.event_name === "Challenged")) disputes++;
    if (isTimeout(events)) timeouts++;
    // The subject's own anchor on this deal, from whichever side it sat.
    // A wallet on both sides of one deal would be a wash trade, which the graph
    // fields already surface; here the buyer slot simply wins.
    const ownAnchor = walletSet.has(deal.buyer.toLowerCase())
      ? deal.buyer_identity_ref
      : walletSet.has(deal.seller.toLowerCase()) ? deal.seller_identity_ref : undefined;
    // undefined is V02, which has no slot at all; null is the same, read back
    // from SQLite. Neither is a deal that could have carried an identity, so
    // neither counts against the subject.
    if (ownAnchor !== undefined && ownAnchor !== null) {
      if (isUnset(ownAnchor)) dealsWithoutAnchor++;
      else {
        dealsWithAnchor++;
        identityAnchors.add(ownAnchor.toLowerCase());
      }
    }
    if (walletSet.has(deal.buyer.toLowerCase())) asBuyer++;
    if (walletSet.has(deal.seller.toLowerCase())) {
      asSeller++;
      const bondPosted = events.some((event) => event.event_name === "BondPosted");
      if (bondPosted) posted++;
      if (events.some((event) => event.event_name === "BondSlashed")) slashed++;
      if (bondReturned(events, bondPosted)) returned++;
    }
    // Deduplicate per deal: repeat_counterparty means the same identity across settled deals, not multiple roles in one deal.
    const dealCounterpartyIdentities = new Set<string>();
    for (const party of [deal.buyer, deal.seller, deal.arbiter, deal.verifier]) {
      const key = party.toLowerCase();
      if (!walletSet.has(key)) {
        counterparties.add(key);
        dealCounterpartyIdentities.add(identity(key));
      }
    }
    for (const counterpartyIdentity of dealCounterpartyIdentities) {
      counterpartyDealCounts.set(
        counterpartyIdentity,
        (counterpartyDealCounts.get(counterpartyIdentity) ?? 0) + 1
      );
    }
    const tokenKey = `${deal.chain_id}:${deal.token.toLowerCase()}`;
    settledTokens.add(tokenKey);
    if (deal.token_decimals !== null) {
      const volume = volumes.get(tokenKey) ?? { raw: 0n, decimals: deal.token_decimals, token: deal.token };
      volume.raw += BigInt(deal.amount);
      volumes.set(tokenKey, volume);
    } else {
      hasUnknownTokenDecimals = true;
    }
    if (
      isOperatorAddress(operatorConfigs.verifier, deal.verifier) ||
      isOperatorAddress(operatorConfigs.arbiter, deal.arbiter)
    ) {
      operatorVerified++;
    }
  });

  const dealsSettled = outcomes.release + outcomes.refund + outcomes.refund_and_slash;
  const subjectIdentities = new Set([...walletSet].map(identity));
  const counterpartyIdentities = new Set([...counterparties].map(identity));
  const distinctCounterparties = counterpartyIdentities.size;
  const clusterIdentities = new Set([...subjectIdentities, ...counterpartyIdentities]);
  const walletsByIdentity = new Map<string, string[]>();
  for (const wallet of counterpartyGraph.keys()) {
    const walletIdentity = identity(wallet);
    const wallets = walletsByIdentity.get(walletIdentity) ?? [];
    wallets.push(wallet);
    walletsByIdentity.set(walletIdentity, wallets);
  }
  const independentCounterparties = [...counterpartyIdentities].filter((counterpartyIdentity) =>
    (walletsByIdentity.get(counterpartyIdentity) ?? []).some((wallet) =>
      [...(counterpartyGraph.get(wallet) ?? [])].some((other) => {
        const otherIdentity = identity(other);
        return otherIdentity !== counterpartyIdentity && !clusterIdentities.has(otherIdentity);
      })
    )
  ).length;
  const independentCounterpartyShare =
    distinctCounterparties === 0 ? 0 : independentCounterparties / distinctCounterparties;
  // An account with no indexed deals has no card and is implicitly unverified by absence.
  // This fallback also covers indexed history that has not established an independent counterparty.
  let trustTier: ReputationCard["trust_tier"] = "unverified";
  if (
    dealsSettled >= REPUTATION_BEARING_MIN_DEALS &&
    independentCounterpartyShare >= REPUTATION_BEARING_MIN_INDEPENDENT_SHARE
  ) {
    trustTier = "reputation_bearing";
  } else if (distinctCounterparties >= 1 && independentCounterpartyShare > 0) {
    trustTier = "accountable";
  }
  const card: ReputationCard = {
    address: displayAddress,
    started_at: new Date(Math.min(...relevant.map((deal) => deal.funded_at)) * 1_000).toISOString(),
    deals_settled: dealsSettled,
    outcomes,
    rates: {
      success_rate: dealsSettled === 0 ? 0 : outcomes.release / dealsSettled,
      dispute_rate: dealsSettled === 0 ? 0 : disputes / dealsSettled,
      timeout_rate: dealsSettled === 0 ? 0 : timeouts / dealsSettled
    },
    bonds: { posted_count: posted, slashed_count: slashed, returned_count: returned },
    roles: { as_buyer: asBuyer, as_seller: asSeller },
    repeat_counterparty: [...counterpartyDealCounts.values()].some((count) => count >= 2),
    graph: {
      distinct_counterparties: distinctCounterparties,
      independent_counterparty_share: independentCounterpartyShare
    },
    provenance: {
      operator_verified: operatorVerified,
      self_adjudicated: dealsSettled - operatorVerified
    },
    trust_tier: trustTier,
    identity_anchor: {
      // Sorted so the same history always renders the same card; a Set's
      // insertion order would make the JSON depend on indexing order.
      anchors: [...identityAnchors].sort(),
      deals_with_anchor: dealsWithAnchor,
      deals_without_anchor: dealsWithoutAnchor
    }
  };

  // Raw amounts from different assets are not comparable. Emit internal volume only for a single token.
  if (settledTokens.size === 1 && !hasUnknownTokenDecimals && volumes.size === 1) {
    const volume = [...volumes.values()][0];
    card.settled_volume = { amount: volume.raw.toString(), token: getAddress(volume.token), human: formatUnits(volume.raw, volume.decimals) };
  }
  return card;
}

export function aggregateReputation(db: SinettiDatabase, wallet: string): ReputationCard | null {
  const address = getAddress(wallet);
  return aggregateForWalletSet(db, new Set([address.toLowerCase()]), address);
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
    // block_timestamp is optional on DealEvent, and a deal whose events all
    // lack one still settled — fall back to funding time rather than dropping
    // the deal or reporting an epoch-zero settlement.
    const timestamps = events
      .map((event) => event.block_timestamp)
      .filter((timestamp): timestamp is number => typeof timestamp === "number");
    settled.push({ deal, resolution, settled_at: Math.max(deal.funded_at, ...timestamps) });
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
  const timestamps = events.map((event) => event.block_timestamp).filter((t): t is number => typeof t === "number");
  return { deal, resolution, settledAt: Math.max(deal.funded_at, ...timestamps) };
}

export function listIndexedAddresses(db: SinettiDatabase): Array<{ address: string; deals_settled: number }> {
  const deals = db.prepare("SELECT buyer, seller, arbiter, verifier FROM deals").all() as Array<Pick<StoredDeal, "buyer" | "seller" | "arbiter" | "verifier">>;
  const addresses = new Set(deals.flatMap((deal) => [deal.buyer, deal.seller, deal.arbiter, deal.verifier]));
  return [...addresses]
    .map((address) => ({ address: getAddress(address), deals_settled: aggregateReputation(db, address)?.deals_settled ?? 0 }))
    .sort((left, right) => left.address.localeCompare(right.address));
}

export function publicCard(card: ReputationCard): Omit<ReputationCard, "settled_volume"> {
  // Volume is computed for internal use but deliberately withheld to reduce public wallet financial profiling.
  const { settled_volume: _privateVolume, ...safe } = card;
  return safe;
}
