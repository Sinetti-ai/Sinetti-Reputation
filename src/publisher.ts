/**
 * Publishing settled Sinetti outcomes into an ERC-8004 Reputation Registry.
 *
 * This is the write side. The read side is `feedback.ts`, which indexes every
 * feedback event as a claim and counts only the entries whose rater can prove
 * a settled deal with the agent. The publisher exists so Sinetti's own
 * settlements pass that check for anyone running the reader: each entry it
 * writes points at a per-deal feedback document carrying the `settlement`
 * claim, pinned by `feedbackHash`.
 *
 * ERC-8004's registry stores five things per entry (`value`, `valueDecimals`,
 * `tag1`, `tag2`, `isRevoked`) and emits the file pointer without storing it.
 * `giveFeedback` is permissionless and the deployed scores are sybil-flooded
 * (see `registries.ts`). That is why nothing in this module or the reader ever
 * calls the registry's summary functions: `REPUTATION_REGISTRY_ABI` below has
 * one function, `giveFeedback`, and a test holds it to that shape. Reading a
 * claim is fine; trusting a score is not.
 */
import { Contract, Provider, Wallet, getAddress, id as keccakText, keccak256, toUtf8Bytes } from "ethers";
import { Resolution, SettledDeal, listSettledDeals } from "./settlement";
import { SinettiDatabase } from "./db";
import { settlementFeedbackDocument, settlementFeedbackUri } from "./standards";
import { RegistryConfig, isAgentOperator, makeProvider, resolveAgentBinding } from "./registries";
export { IDENTITY_REGISTRY_ABI, KNOWN_REGISTRIES, RegistryConfig, getRegistry, makeProvider } from "./registries";

/**
 * The one function this service may call on a Reputation Registry.
 *
 * Deliberately not the full interface. Adding `getSummary` or `readFeedback`
 * here is the change that would let a later edit quietly start consuming sybil
 * scores; keeping them out means such an edit has to state itself.
 */
export const REPUTATION_REGISTRY_ABI = [
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)"
] as const;

/**
 * Outcome to ERC-8004 `value`, on a 0-100 integer scale.
 *
 * The registry gives one signed number and two strings. Three Sinetti outcomes
 * do not fit in one number without loss, so the loss is placed deliberately:
 * the number answers "did the seller get paid", and `tag1` carries which of the
 * two failure modes it was. A slashed default and a plain refund therefore
 * share a value and differ by tag.
 *
 * Negative values are available (`int128`) and are not used. A -100 for
 * slashing would invent a scale convention nobody else reads, and any consumer
 * naively averaging would produce a number whose meaning depends on knowing
 * ours. Staying inside 0-100 keeps a naive average interpretable.
 */
export const OUTCOME_VALUE: Record<Resolution, number> = {
  release: 100,
  refund: 0,
  refund_and_slash: 0
};

export const VALUE_DECIMALS = 0;

export interface FeedbackPlan {
  deployment: string;
  contract: string;
  dealId: string;
  subject: string;
  agentId: string;
  value: number;
  valueDecimals: number;
  tag1: Resolution;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: string;
}

/**
 * `feedbackHash` pins the per-deal feedback document. ERC-8004 defines it as
 * keccak-256 of the file bytes, and the reader refuses a file whose bytes do
 * not hash to it. The document is derived from settled chain events and the
 * path parameters alone, so the bytes served later are the bytes hashed now.
 */
export function feedbackDocumentHash(document: unknown): string {
  return keccak256(toUtf8Bytes(JSON.stringify(document)));
}

/**
 * What would be written, computed without touching the network.
 *
 * Separated from sending so an operator can read the exact set of on-chain
 * writes before authorising any of them. This is the only review point: after
 * `publish`, every entry is permanent and ERC-8004 offers no edit, only
 * `revokeFeedback` by the original client.
 */
export function planPublication(
  db: SinettiDatabase,
  registry: RegistryConfig,
  agentIds: Map<string, string>,
  publisher: string,
  options: { subject?: string; limit?: number } = {}
): FeedbackPlan[] {
  const client = getAddress(publisher);
  const only = options.subject ? getAddress(options.subject) : null;
  const published = new Set(
    (db.prepare(
      "SELECT deployment, contract, deal_id, subject FROM erc8004_publications WHERE registry_chain_id = ? AND registry = ?"
    ).all(registry.chainId, registry.reputationRegistry) as Array<{
      deployment: string; contract: string; deal_id: string; subject: string;
    }>).map((row) => `${row.deployment}|${row.contract}|${row.deal_id}|${row.subject}`)
  );

  const plans: FeedbackPlan[] = [];
  for (const settled of listSettledDeals(db)) {
    // The seller is the subject. Reputation here is about whether delivery
    // happened, which is a claim about the party that owed it.
    const subject = getAddress(settled.deal.seller);
    if (only && subject !== only) continue;

    const key = `${settled.deal.deployment}|${getAddress(settled.deal.contract)}|${settled.deal.deal_id}|${subject}`;
    if (published.has(key)) continue;

    const agentId = agentIds.get(subject);
    if (!agentId) continue;

    // The document the entry points at: the settlement claim, with the fields
    // ERC-8004 asks a feedback file to carry. Pinned by hash, so it must be
    // derivable from the path alone; see standards.ts.
    const reference = {
      registryChainId: registry.chainId,
      registry: registry.reputationRegistry,
      agentId,
      client,
      chainId: settled.deal.chain_id,
      contract: getAddress(settled.deal.contract),
      dealId: settled.deal.deal_id
    };
    const document = settlementFeedbackDocument(db, reference);
    if (!document) continue;

    plans.push({
      deployment: settled.deal.deployment,
      contract: getAddress(settled.deal.contract),
      dealId: settled.deal.deal_id,
      subject,
      agentId,
      value: OUTCOME_VALUE[settled.resolution],
      valueDecimals: VALUE_DECIMALS,
      tag1: settled.resolution,
      // CAIP-10 of the escrow that produced the outcome. tag2 is stored, so a
      // reader can summarise per Sinetti deployment without trusting us to say
      // which one a given entry came from.
      tag2: `eip155:${settled.deal.chain_id}:${getAddress(settled.deal.contract)}`,
      // Optional in ERC-8004, and left empty: the field means the agent's own
      // service endpoint, which Sinetti does not know. Inventing one would be a
      // claim about the seller's infrastructure that we cannot support.
      endpoint: "",
      feedbackURI: settlementFeedbackUri(reference),
      feedbackHash: feedbackDocumentHash(document)
    });
    if (options.limit !== undefined && plans.length >= options.limit) break;
  }
  return plans;
}

export interface AgentIdCheck {
  agentId: string;
  wallet: string | null;
  owner: string | null;
  matchesSubject: boolean;
  publisherIsOwner: boolean;
}

/**
 * Confirm an agentId really belongs to the wallet we are about to rate.
 *
 * ERC-8004 assigns agentIds as incrementing ERC-721 token ids with no reverse
 * index from wallet to id, so the mapping has to come from outside and has to
 * be checked. Getting it wrong writes a permanent entry against an unrelated
 * agent.
 *
 * `publisherIsOwner` covers the owner and any approved operator, because the spec
 * forbids both: "The feedback submitter MUST NOT be the agent owner or an approved
 * operator for agentId". The call reverts, after gas, if it is true.
 */
export async function checkAgentId(
  provider: Provider,
  registry: RegistryConfig,
  agentId: string,
  subject: string,
  publisher: string
): Promise<AgentIdCheck> {
  const { wallet, owner } = await resolveAgentBinding(provider, registry, agentId);
  const expected = getAddress(subject);
  return {
    agentId,
    wallet,
    owner,
    // Either binding counts: an agent may declare an operational wallet, or the
    // token owner may simply be the trading address.
    matchesSubject: wallet === expected || owner === expected,
    publisherIsOwner: await isAgentOperator(provider, registry, agentId, owner, publisher)
  };
}

export interface PublishResult {
  plan: FeedbackPlan;
  txHash: string;
}

export interface PendingPublication {
  deployment: string;
  contract: string;
  dealId: string;
  subject: string;
  agentId: string;
  txHash: string | null;
}

/**
 * Rows written before a send that never recorded a receipt. Each one blocks
 * its deal from being planned again (the plan reads the whole table), so a
 * crash cannot double-publish; the cost is that the operator has to look at
 * the chain and either record the receipt or delete the row. `tx_hash` NULL
 * means the send itself may not have happened; a hash means it was broadcast.
 */
export function listPendingPublications(db: SinettiDatabase, registry: RegistryConfig): PendingPublication[] {
  return (db.prepare(
    "SELECT deployment, contract, deal_id, subject, agent_id, tx_hash FROM erc8004_publications "
    + "WHERE registry_chain_id = ? AND registry = ? AND published_at IS NULL"
  ).all(registry.chainId, registry.reputationRegistry) as Array<{
    deployment: string; contract: string; deal_id: string; subject: string; agent_id: string; tx_hash: string | null;
  }>).map((row) => ({
    deployment: row.deployment, contract: row.contract, dealId: row.deal_id,
    subject: row.subject, agentId: row.agent_id, txHash: row.tx_hash
  }));
}

/**
 * Send the planned feedback, recording each success before sending the next.
 *
 * Recorded one at a time rather than in a final batch: a crash halfway through
 * must not leave writes on-chain that our ledger has never heard of, because
 * the next run would repeat them and ERC-8004 has no way to merge duplicates.
 */
export async function publish(
  db: SinettiDatabase,
  registry: RegistryConfig,
  signer: Wallet,
  plans: FeedbackPlan[]
): Promise<PublishResult[]> {
  const reputation = new Contract(registry.reputationRegistry, REPUTATION_REGISTRY_ABI, signer);
  const reserve = db.prepare(`
    INSERT INTO erc8004_publications (
      registry_chain_id, registry, deployment, contract, deal_id, subject,
      agent_id, outcome, value, feedback_uri, tx_hash, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `);
  const release = db.prepare(`
    DELETE FROM erc8004_publications
    WHERE registry_chain_id = ? AND registry = ? AND deployment = ? AND contract = ? AND deal_id = ? AND subject = ?
  `);
  const broadcast = db.prepare(`
    UPDATE erc8004_publications SET tx_hash = ?
    WHERE registry_chain_id = ? AND registry = ? AND deployment = ? AND contract = ? AND deal_id = ? AND subject = ?
  `);
  const confirm = db.prepare(`
    UPDATE erc8004_publications SET tx_hash = ?, published_at = ?
    WHERE registry_chain_id = ? AND registry = ? AND deployment = ? AND contract = ? AND deal_id = ? AND subject = ?
  `);
  if (listPendingPublications(db, registry).length > 0) {
    throw new Error(
      "pending ERC-8004 publications exist for this registry; reconcile them against the chain "
      + "(record the receipt or delete the row) before publishing more"
    );
  }

  const results: PublishResult[] = [];
  for (const plan of plans) {
    const check = await checkAgentId(signer.provider!, registry, plan.agentId, plan.subject, signer.address);
    if (!check.matchesSubject) {
      throw new Error(
        `agentId ${plan.agentId} is not bound to ${plan.subject} `
        + `(wallet=${check.wallet ?? "unset"}, owner=${check.owner ?? "unset"}); refusing to publish`
      );
    }
    if (check.publisherIsOwner) {
      throw new Error(
        `publisher ${signer.address} owns agentId ${plan.agentId}; ERC-8004 forbids self-feedback and the call would revert`
      );
    }

    // Reserve the row first. If the process dies anywhere after this point the
    // deal stays reserved and is never planned again, which is the property a
    // paid, append-only, uneditable write needs: at most once, never twice.
    const key = [registry.chainId, registry.reputationRegistry, plan.deployment, plan.contract, plan.dealId, plan.subject] as const;
    reserve.run(...key, plan.agentId, plan.tag1, plan.value, plan.feedbackURI);
    let tx;
    try {
      tx = await reputation.giveFeedback(
        plan.agentId, plan.value, plan.valueDecimals, plan.tag1, plan.tag2,
        plan.endpoint, plan.feedbackURI, plan.feedbackHash
      );
    } catch (error) {
      // Nothing was broadcast, so nothing is on chain to protect; free the deal.
      release.run(...key);
      throw error;
    }
    broadcast.run(tx.hash, ...key);
    const receipt = await tx.wait();
    confirm.run(receipt.hash, Math.floor(Date.now() / 1_000), ...key);
    results.push({ plan, txHash: receipt.hash });
  }
  return results;
}

/** `0xADDRESS=AGENTID,0x…=…` from the CLI or environment. */
export function parseAgentIds(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    const [address, agentId] = pair.split("=");
    if (!address || !agentId || !/^[0-9]+$/.test(agentId.trim())) {
      throw new Error(`Malformed agent id mapping: ${pair}. Expected 0xADDRESS=AGENTID`);
    }
    map.set(getAddress(address.trim()), agentId.trim());
  }
  return map;
}

/**
 * The signer, which exists only in this module.
 *
 * `sinetti-rep`'s indexer and API accept no private key and never will; that is
 * a stated property of the service. Publishing is the one operation that needs
 * one, so it lives behind its own entry point and its own variable, and is
 * never constructed on the API path.
 */
export function loadSigner(registry: RegistryConfig, keyVar = "ERC8004_PRIVATE_KEY"): Wallet {
  const key = process.env[keyVar];
  if (!key) throw new Error(`${keyVar} is not set. Publishing is opt-in and never runs from the indexer or API.`);
  return new Wallet(key, makeProvider(registry));
}

/** Exported for the ABI-shape test; keccak of the one permitted call. */
export const GIVE_FEEDBACK_SELECTOR = keccakText(
  "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)"
).slice(0, 10);
