/**
 * The ERC-8004 reader: feedback events in, verified entries out.
 *
 * Three steps, each recorded in SQLite so the whole thing is reproducible from
 * the chain plus the documents the chain points at:
 *
 *  1. `indexRegistryFeedback` records every `NewFeedback` and `FeedbackRevoked`
 *     event from a Reputation Registry. The score and tags come from the event;
 *     so does `feedbackURI`, which the contract emits and does not store.
 *  2. `checkFeedbackFiles` fetches each entry's feedback file under strict
 *     rules (https, ipfs or inline data URI, 64 KB, hash must match when one was given, no
 *     private hosts) and looks for a settlement claim in it.
 *  3. `verifySettlement` checks that claim against indexed escrow deals: the
 *     deal settled, the rater was a party, and the agent's wallet or owner was
 *     the other party.
 *
 * An entry that passes step 3 is `verified`. Everything else stays
 * `unverified`, is counted, and contributes nothing to any score. Unknown is
 * unknown; it is never read as a failure and never laundered into a number.
 */
import { Interface, Log, Provider, JsonRpcProvider, getAddress, keccak256, isAddress } from "ethers";
import { Resolution, resolveDeal } from "./aggregator";
import { SinettiDatabase, getSyncCheckpoint } from "./db";
import { REPAIR_PASSES, getLogsRetryingEmpty, getLogsSliced, holeOnCooldown, sequenceHoles, topicOf } from "./logs";
import { AgentBinding, REPUTATION_REGISTRY_EVENTS_ABI, RegistryConfig, registryCaip10, resolveAgentBinding } from "./registries";

const iface = new Interface(REPUTATION_REGISTRY_EVENTS_ABI);

export type FileStatus =
  | "pending" | "ok" | "no_uri" | "scheme_refused" | "private_host" | "too_large" | "unreachable" | "hash_mismatch" | "invalid_json";
export type Verification = "unverified" | "settlement";

export interface FeedbackRow {
  registry_chain_id: number;
  registry: string;
  agent_id: string;
  client: string;
  feedback_index: number;
  value: string;
  value_decimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedback_uri: string;
  feedback_hash: string;
  block_number: number;
  block_timestamp: number;
  tx_hash: string;
  log_index: number;
  revoked: number;
  file_status: FileStatus;
  file_json: string | null;
  verification: Verification;
  evidence_json: string | null;
  checked_at: number | null;
}

/** The settlement claim a rater puts in its feedback file. */
export interface SettlementClaim {
  chainId: number;
  contract: string;
  dealId: string;
}

export interface SettlementEvidence {
  deployment: string;
  chainId: number;
  contract: string;
  dealId: string;
  resolution: Resolution;
  clientRole: "buyer" | "seller";
  agentAddress: string;
  settledAt: number;
}

// ---------------------------------------------------------------------------
// 1. Events

const ZERO_HASH = `0x${"00".repeat(32)}`;

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got: ${value}`);
  return value;
}

export interface IndexFeedbackOptions {
  provider?: Provider;
  toBlock?: number;
  chunkSize?: number;
}

/**
 * Record feedback events from `fromBlock` (or the last checkpoint) up to the
 * confirmed tip. Checkpoints share `sync_state` with the escrow indexer, keyed
 * by registry name and address.
 *
 * ponytail: no reorg reconciliation beyond the confirmation depth. Feedback is
 * append-only and a reorged-out entry re-appears under the same key if it is
 * re-included, so the failure mode is a stale row, never a duplicate. Add the
 * escrow indexer's block-hash history if a registry is ever read at depth 1.
 */
export async function indexRegistryFeedback(
  db: SinettiDatabase,
  registry: RegistryConfig,
  options: IndexFeedbackOptions = {}
): Promise<{ fromBlock: number; toBlock: number; events: number; repaired: number; missing: number }> {
  const chunkSize = positiveInteger("LOG_CHUNK_SIZE", options.chunkSize ?? Number(process.env.LOG_CHUNK_SIZE ?? 2_000));
  const provider = options.provider ?? new JsonRpcProvider(registry.rpcUrl, registry.chainId, { staticNetwork: true });
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== registry.chainId) {
    throw new Error(`RPC chain ${network.chainId} does not match registry ${registry.name} (${registry.chainId})`);
  }
  const address = getAddress(registry.reputationRegistry);
  if ((await provider.getCode(address)) === "0x") {
    throw new Error(`No contract code at ${address} on chain ${registry.chainId}; refusing to index a registry that is not there`);
  }

  const checkpoint = getSyncCheckpoint(db, registry.name, address);
  const confirmedTip = (await provider.getBlockNumber()) - registry.confirmations;
  const latest = Math.min(options.toBlock ?? confirmedTip, confirmedTip);
  const start = checkpoint ? Math.max(registry.fromBlock, checkpoint.block + 1) : registry.fromBlock;
  if (start > latest) return { fromBlock: start, toBlock: latest, events: 0, repaired: 0, missing: 0 };

  const insert = db.prepare(`
    INSERT OR IGNORE INTO erc8004_feedback (
      registry_chain_id, registry, agent_id, client, feedback_index, value, value_decimals, tag1, tag2, endpoint,
      feedback_uri, feedback_hash, block_number, block_timestamp, tx_hash, log_index, revoked, file_status, verification
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', 'unverified')
  `);
  const revoke = db.prepare(`
    UPDATE erc8004_feedback SET revoked = 1
    WHERE registry_chain_id = ? AND registry = ? AND agent_id = ? AND client = ? AND feedback_index = ?
  `);
  const checkpointWrite = db.prepare(`
    INSERT INTO sync_state (deployment, contract, last_indexed_block, last_indexed_block_hash)
    VALUES (?, ?, ?, NULL)
    ON CONFLICT(deployment, contract) DO UPDATE SET last_indexed_block = excluded.last_indexed_block
  `);

  let inserted = 0;
  const topics: string[] = [];
  iface.forEachEvent((event) => topics.push(event.topicHash));

  async function ingest(logs: Log[], checkpointTo: number | null): Promise<void> {
    const timestamps = new Map<number, number>();
    const rows: Array<() => number> = [];
    for (const log of logs) {
      const parsed = iface.parseLog(log);
      if (!parsed) continue;
      const agentId = String(parsed.args.agentId);
      const client = getAddress(String(parsed.args.clientAddress));
      const index = Number(parsed.args.feedbackIndex);
      if (parsed.name === "FeedbackRevoked") {
        rows.push(() => (revoke.run(registry.chainId, address, agentId, client, index), 0));
        continue;
      }
      let timestamp = timestamps.get(log.blockNumber);
      if (timestamp === undefined) {
        const block = await provider.getBlock(log.blockNumber);
        if (!block) throw new Error(`Missing block ${log.blockNumber}`);
        timestamp = block.timestamp;
        timestamps.set(log.blockNumber, timestamp);
      }
      const args = parsed.args;
      rows.push(() => insert.run(
        registry.chainId, address, agentId, client, index,
        String(args.value), Number(args.valueDecimals), String(args.tag1), String(args.tag2), String(args.endpoint),
        String(args.feedbackURI), String(args.feedbackHash).toLowerCase(),
        log.blockNumber, timestamp, log.transactionHash, log.index
      ).changes);
    }
    db.transaction(() => {
      for (const write of rows) inserted += write();
      if (checkpointTo !== null) checkpointWrite.run(registry.name, address, checkpointTo);
    })();
  }

  for (let from = start; from <= latest; from += chunkSize) {
    const to = Math.min(from + chunkSize - 1, latest);
    await ingest(await getLogsRetryingEmpty(provider, { address, fromBlock: from, toBlock: to, topics: [topics] }), to);
  }

  // feedbackIndex counts from 1 per (agentId, client) in the reference registry, so a hole
  // in a pair's indexes is a window some RPC answered empty. Each pair with holes is re-asked
  // by its two indexed topics between the neighbouring known entries' blocks (a hole before
  // the first known entry starts at the agent's registration block when known), then left
  // alone for an hour. ponytail: entries after a pair's highest known index are invisible
  // here, the same tail lag as the identity scan.
  let repaired = 0;
  for (let pass = 0; pass < REPAIR_PASSES; pass += 1) {
    const pairs = feedbackHoles(db, registry).filter((pair) => pass > 0 || !holeOnCooldown(`${registry.name}:fb:${pair.agentId}:${pair.client}:${pair.holes[0].from}`));
    if (pairs.length === 0) break;
    for (const pair of pairs) {
      const before = inserted;
      await ingest(await getLogsSliced(provider, {
        address,
        fromBlock: pair.holes[0].fromBlock,
        toBlock: pair.holes[pair.holes.length - 1].toBlock,
        topics: [topics, topicOf(BigInt(pair.agentId)), topicOf(pair.client)]
      }), null);
      repaired += inserted - before;
    }
  }
  const missing = countMissingFeedback(db, registry);
  return { fromBlock: start, toBlock: latest, events: inserted, repaired, missing };
}

/** Pairs (agentId, client) whose feedback indexes have holes, with the block window for each hole. */
export function feedbackHoles(
  db: SinettiDatabase,
  registry: RegistryConfig
): Array<{ agentId: string; client: string; holes: ReturnType<typeof sequenceHoles> }> {
  const address = getAddress(registry.reputationRegistry);
  const pairs = db.prepare(
    "SELECT agent_id, client, MAX(feedback_index) AS top, COUNT(*) AS seen FROM erc8004_feedback "
      + "WHERE registry_chain_id = ? AND registry = ? GROUP BY agent_id, client HAVING top > seen"
  ).all(registry.chainId, address) as Array<{ agent_id: string; client: string }>;
  const knownIndexes = db.prepare(
    "SELECT feedback_index AS position, block_number AS block FROM erc8004_feedback "
      + "WHERE registry_chain_id = ? AND registry = ? AND agent_id = ? AND client = ? ORDER BY position"
  );
  const registeredBlock = db.prepare(
    "SELECT registered_block FROM erc8004_agents WHERE registry_chain_id = ? AND registry = ? AND agent_id = ?"
  );
  const out: Array<{ agentId: string; client: string; holes: ReturnType<typeof sequenceHoles> }> = [];
  for (const pair of pairs) {
    const registered = registeredBlock.get(registry.chainId, getAddress(registry.identityRegistry), pair.agent_id) as { registered_block: number } | undefined;
    const floor = Math.max(registry.fromBlock, registered?.registered_block ?? 0);
    const known = knownIndexes.all(registry.chainId, address, pair.agent_id, pair.client) as Array<{ position: number; block: number }>;
    const holes = sequenceHoles(known, 1, floor);
    if (holes.length > 0) out.push({ agentId: pair.agent_id, client: pair.client, holes });
  }
  return out;
}

/** Feedback entries the index should hold and does not. Zero means the feedback scan is complete up to its checkpoint. */
export function countMissingFeedback(db: SinettiDatabase, registry: RegistryConfig): number {
  return feedbackHoles(db, registry).reduce(
    (sum, pair) => sum + pair.holes.reduce((inner, hole) => inner + hole.to - hole.from + 1, 0),
    0
  );
}

// ---------------------------------------------------------------------------
// 2. Files

export const MAX_FEEDBACK_FILE_BYTES = 65_536;

export type Fetcher = (url: string) => Promise<{ status: number; body: Uint8Array }>;

/** Default fetcher: Node's global fetch with a hard byte cap on the body. */
export const nodeFetcher: Fetcher = async (url) => {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  const reader = response.body?.getReader();
  if (!reader) return { status: response.status, body: new Uint8Array() };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FEEDBACK_FILE_BYTES) {
      await reader.cancel();
      return { status: response.status, body: new Uint8Array(MAX_FEEDBACK_FILE_BYTES + 1) };
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return { status: response.status, body };
};

/**
 * Hosts that are never fetched. A feedback URI is attacker-controlled input
 * and this service may run beside private infrastructure.
 *
 * ponytail: literal checks only, no DNS resolution. A public hostname that
 * resolves to a private address still gets through; resolve-then-check before
 * connecting if this ever runs somewhere that matters.
 */
export function isPrivateHost(hostname: string): boolean {
  // The URL parser keeps a trailing root dot on names ("localhost." resolves
  // to loopback) while stripping it from IPv4 literals, so drop it here.
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19))
      || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (host.includes(":")) {
    return host === "::1" || host === "::" || host.startsWith("fe80:") || host.startsWith("fec0:") || host.startsWith("fc") || host.startsWith("fd")
      || host.startsWith("::ffff:") || host.startsWith("64:ff9b:") || host.startsWith("2002:");
  }
  return false;
}

export function ipfsGateway(): string {
  const gateway = process.env.IPFS_GATEWAY ?? "https://ipfs.io/ipfs/";
  return gateway.endsWith("/") ? gateway : `${gateway}/`;
}

/**
 * An inline `data:` URI, decoded. Common for ERC-8004 registration files,
 * which are small and change rarely; nothing is fetched, so none of the host
 * rules apply. Only JSON media types are accepted, and the byte cap still holds.
 */
export function decodeDataUri(uri: string): Uint8Array | null {
  const match = uri.match(/^data:([^,]*),([\s\S]*)$/i);
  if (!match) return null;
  const [mediaType, payload] = [match[1].toLowerCase(), match[2]];
  const parameters = mediaType.split(";").map((part) => part.trim());
  const type = parameters[0] || "text/plain";
  if (type !== "application/json" && type !== "text/plain") return null;
  try {
    if (parameters.includes("base64")) return new Uint8Array(Buffer.from(payload, "base64"));
    return new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return null;
  }
}

/** Turn a feedback URI into something fetchable, or say why not. */
export function resolveFeedbackUri(uri: string): { url: string } | { data: Uint8Array } | { status: FileStatus } {
  if (!uri.trim()) return { status: "no_uri" };
  if (/^data:/i.test(uri)) {
    const data = decodeDataUri(uri);
    return data ? { data } : { status: "scheme_refused" };
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { status: "scheme_refused" };
  }
  if (parsed.protocol === "ipfs:") {
    const path = `${parsed.hostname}${parsed.pathname}`;
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return { status: "scheme_refused" };
    }
    if (!path || decoded.includes("..")) return { status: "scheme_refused" };
    return { url: `${ipfsGateway()}${path}` };
  }
  if (parsed.protocol !== "https:") return { status: "scheme_refused" };
  if (parsed.username || parsed.password) return { status: "scheme_refused" };
  if (isPrivateHost(parsed.hostname)) return { status: "private_host" };
  return { url: parsed.toString() };
}

export interface FetchedFile {
  status: FileStatus;
  json: Record<string, unknown> | null;
}

/**
 * Fetch and check one feedback file. `expectedHash` is the on-chain
 * `feedbackHash`; ERC-8004 defines it as keccak-256 of the file bytes, and a
 * zero hash means the rater pinned nothing.
 */
export async function fetchFeedbackFile(uri: string, expectedHash: string, fetcher: Fetcher = nodeFetcher): Promise<FetchedFile> {
  const resolved = resolveFeedbackUri(uri);
  if ("status" in resolved) return { status: resolved.status, json: null };
  let response: Awaited<ReturnType<Fetcher>>;
  if ("data" in resolved) {
    response = { status: 200, body: resolved.data };
  } else {
    try {
      response = await fetcher(resolved.url);
    } catch {
      return { status: "unreachable", json: null };
    }
    if (response.status < 200 || response.status >= 300) return { status: "unreachable", json: null };
  }
  if (response.body.byteLength > MAX_FEEDBACK_FILE_BYTES) return { status: "too_large", json: null };
  const pinned = expectedHash.toLowerCase() !== ZERO_HASH;
  if (pinned && keccak256(response.body).toLowerCase() !== expectedHash.toLowerCase()) return { status: "hash_mismatch", json: null };
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(response.body));
    if (typeof json !== "object" || json === null || Array.isArray(json)) return { status: "invalid_json", json: null };
    // JSON.parse is iterative, JSON.stringify is recursive: a document nested
    // thousands deep parses and then overflows the stack when stored. Storing
    // is part of accepting it, so it is tried here, once, where a throw is a
    // status and not a crash of the whole check pass.
    JSON.stringify(json);
    return { status: "ok", json: json as Record<string, unknown> };
  } catch {
    return { status: "invalid_json", json: null };
  }
}

/** A JSON document nobody pinned: same rules, no hash to check. Registration files and agent cards. */
export function fetchJsonDocument(uri: string, fetcher: Fetcher = nodeFetcher): Promise<FetchedFile> {
  return fetchFeedbackFile(uri, ZERO_HASH, fetcher);
}

/**
 * The A2A fields a feedback file may carry: which of the agent's skills the
 * rating is about, and the task it came from. Declared by the rater, shown
 * beside a verified entry, never used to verify it.
 */
export function readA2AFields(file: Record<string, unknown>): { skillIds: string[]; taskId: string | null } {
  const skillIds = Array.isArray(file.skills)
    ? file.skills.slice(0, 20).map((skill) => {
      if (typeof skill === "string") return skill.trim().slice(0, 120);
      if (typeof skill === "object" && skill !== null && typeof (skill as Record<string, unknown>).id === "string") {
        return String((skill as Record<string, unknown>).id).trim().slice(0, 120);
      }
      return "";
    }).filter(Boolean)
    : [];
  return { skillIds, taskId: typeof file.taskId === "string" && file.taskId.trim() ? file.taskId.trim().slice(0, 120) : null };
}

/** The `settlement` field of a feedback file, if it is well formed. */
export function readSettlementClaim(file: Record<string, unknown>): SettlementClaim | null {
  const claim = file.settlement;
  if (typeof claim !== "object" || claim === null) return null;
  const { chainId, contract, dealId } = claim as Record<string, unknown>;
  if (!Number.isSafeInteger(chainId) || Number(chainId) <= 0) return null;
  if (typeof contract !== "string" || !isAddress(contract)) return null;
  if (typeof dealId !== "string" || !/^[0-9]+$/.test(dealId)) return null;
  return { chainId: Number(chainId), contract: getAddress(contract), dealId };
}

// ---------------------------------------------------------------------------
// 3. Verification

/**
 * Does the indexed escrow history back this rater's claim about this agent?
 *
 * Three facts, all from public chain data: the named deal settled with a
 * classifiable outcome; the rater was its buyer or seller; and the agent's
 * bound address (declared wallet or token owner) was the other party. Nothing
 * off-chain is consulted, so any reader of the same chains reaches the same
 * answer.
 */
export function verifySettlement(
  db: SinettiDatabase,
  claim: SettlementClaim,
  client: string,
  agent: AgentBinding
): SettlementEvidence | null {
  const resolved = resolveDeal(db, claim.chainId, claim.contract, claim.dealId);
  if (!resolved) return null;
  const { deal, resolution, settledAt } = resolved;
  const rater = client.toLowerCase();
  const agentAddresses = new Set([agent.wallet, agent.owner].filter((a): a is string => !!a).map((a) => a.toLowerCase()));
  // The rater must be a party and must not be the agent. An owner who declares
  // a second wallet, deals with himself and rates from the first address is the
  // obvious sybil, and a deal with one address on both sides is no deal.
  if (agentAddresses.has(rater)) return null;
  const buyer = deal.buyer.toLowerCase();
  const seller = deal.seller.toLowerCase();
  if (buyer === seller) return null;
  let clientRole: "buyer" | "seller";
  let agentAddress: string;
  if (rater === buyer && agentAddresses.has(seller)) { clientRole = "buyer"; agentAddress = deal.seller; }
  else if (rater === seller && agentAddresses.has(buyer)) { clientRole = "seller"; agentAddress = deal.buyer; }
  else return null;
  return {
    deployment: deal.deployment,
    chainId: deal.chain_id,
    contract: getAddress(deal.contract),
    dealId: deal.deal_id,
    resolution,
    clientRole,
    agentAddress: getAddress(agentAddress),
    settledAt
  };
}

export interface CheckOptions {
  provider?: Provider;
  fetcher?: Fetcher;
  /** Rows per call. The CLI passes one so a flood of slow hosts cannot stall indexing. */
  limit?: number;
  now?: () => number;
  /** Seconds after which an `unreachable` file is tried again. Default one day. */
  retryAfter?: number;
}

/**
 * Mark entries for a fresh check. With no filter, every entry on the registry
 * goes back to `pending`; with an agentId, only that agent's entries, for
 * example after it changes its declared wallet. Returns the rows reset.
 */
export function recheckFeedback(db: SinettiDatabase, registry: RegistryConfig, agentId?: string): number {
  const address = getAddress(registry.reputationRegistry);
  const result = agentId
    ? db.prepare("UPDATE erc8004_feedback SET file_status = 'pending' WHERE registry_chain_id = ? AND registry = ? AND agent_id = ?")
      .run(registry.chainId, address, agentId)
    : db.prepare("UPDATE erc8004_feedback SET file_status = 'pending' WHERE registry_chain_id = ? AND registry = ?")
      .run(registry.chainId, address);
  return result.changes;
}

/**
 * Fetch and verify entries not yet checked, plus `unreachable` ones whose last
 * attempt is older than `retryAfter`. Every other status is final until
 * `recheckFeedback` resets it: a hash mismatch or a refused scheme does not
 * change by waiting. Bindings are looked up once per agentId per call.
 */
export async function checkFeedbackFiles(db: SinettiDatabase, registry: RegistryConfig, options: CheckOptions = {}): Promise<number> {
  const provider = options.provider ?? new JsonRpcProvider(registry.rpcUrl, registry.chainId, { staticNetwork: true });
  const fetcher = options.fetcher ?? nodeFetcher;
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  const address = getAddress(registry.reputationRegistry);
  const retryBefore = now() - (options.retryAfter ?? 86_400);
  const pending = db.prepare(`
    SELECT * FROM erc8004_feedback
    WHERE registry_chain_id = ? AND registry = ?
      AND (file_status = 'pending' OR (file_status = 'unreachable' AND checked_at < ?))
    ORDER BY block_number, log_index ${options.limit ? `LIMIT ${positiveInteger("limit", options.limit)}` : ""}
  `).all(registry.chainId, address, retryBefore) as FeedbackRow[];
  const record = db.prepare(`
    UPDATE erc8004_feedback SET file_status = ?, file_json = ?, verification = ?, evidence_json = ?, checked_at = ?
    WHERE registry_chain_id = ? AND registry = ? AND agent_id = ? AND client = ? AND feedback_index = ?
  `);
  const bindings = new Map<string, AgentBinding>();
  for (const row of pending) {
    const file = await fetchFeedbackFile(row.feedback_uri, row.feedback_hash, fetcher);
    let verification: Verification = "unverified";
    let evidence: SettlementEvidence | null = null;
    const claim = file.json ? readSettlementClaim(file.json) : null;
    if (claim) {
      let binding = bindings.get(row.agent_id);
      if (!binding) {
        binding = await resolveAgentBinding(provider, registry, row.agent_id);
        bindings.set(row.agent_id, binding);
      }
      evidence = verifySettlement(db, claim, row.client, binding);
      if (evidence) verification = "settlement";
    }
    record.run(
      file.status, file.json ? JSON.stringify(file.json) : null, verification, evidence ? JSON.stringify(evidence) : null, now(),
      row.registry_chain_id, row.registry, row.agent_id, row.client, row.feedback_index
    );
  }
  return pending.length;
}

// ---------------------------------------------------------------------------
// Cards

export interface VerifiedEntry {
  client: string;
  feedback_index: number;
  value: string;
  value_decimals: number;
  tag1: string;
  tag2: string;
  feedback_uri: string;
  block_number: number;
  block_timestamp: number;
  tx_hash: string;
  evidence: SettlementEvidence;
  /** A2A skill ids the rater named in the file. Ids only; `identity.ts` matches them to the agent card. */
  skill_ids: string[];
  task_id: string | null;
}

export interface AgentFeedbackCard {
  registry: string;
  agent_id: string;
  feedback: { total: number; revoked: number; unchecked: number; verified: number; duplicates: number };
  /** Mean of verified, unrevoked values on their own decimal scale; null with none. */
  verified_score: number | null;
  verified_clients: string[];
  entries: VerifiedEntry[];
}

/**
 * The card for one agentId on one registry. Only verified entries are listed;
 * the rest are counted. `verified_clients` is the list a reader can pass to
 * ERC-8004's own `getSummary(agentId, clientAddresses, …)`, which is the hook
 * the standard leaves for exactly this.
 */
export function agentFeedbackCard(db: SinettiDatabase, registry: RegistryConfig, agentId: string): AgentFeedbackCard | null {
  const address = getAddress(registry.reputationRegistry);
  const rows = db.prepare(
    "SELECT * FROM erc8004_feedback WHERE registry_chain_id = ? AND registry = ? AND agent_id = ? ORDER BY block_number, log_index"
  ).all(registry.chainId, address, agentId) as FeedbackRow[];
  if (rows.length === 0) return null;
  // One settled deal backs one rating per rater. A counterparty who rates the
  // same deal ten times has one verified entry, the earliest; the rest are
  // counted with everything else.
  const seenDeals = new Set<string>();
  const verified = rows.filter((row) => {
    if (row.verification !== "settlement" || row.revoked !== 0) return false;
    const evidence = JSON.parse(row.evidence_json!) as SettlementEvidence;
    const key = `${row.client.toLowerCase()}|${evidence.chainId}|${evidence.contract.toLowerCase()}|${evidence.dealId}`;
    if (seenDeals.has(key)) return false;
    seenDeals.add(key);
    return true;
  });
  // ponytail: Number() on an int128. Precision goes above 2^53 and the scale is
  // whatever the rater chose; Sinetti's own entries are 0 or 100. Switch to a
  // decimal library if anyone verified ever rates outside that range.
  const values = verified.map((row) => Number(row.value) / 10 ** row.value_decimals);
  return {
    registry: registryCaip10(registry),
    agent_id: agentId,
    feedback: {
      total: rows.length,
      revoked: rows.filter((row) => row.revoked === 1).length,
      unchecked: rows.filter((row) => row.file_status === "pending").length,
      verified: verified.length,
      duplicates: rows.filter((row) => row.verification === "settlement" && row.revoked === 0).length - verified.length
    },
    verified_score: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    verified_clients: [...new Set(verified.map((row) => row.client))].sort(),
    entries: verified.map((row) => ({
      ...readA2AFieldsOf(row),
      client: row.client,
      feedback_index: row.feedback_index,
      value: row.value,
      value_decimals: row.value_decimals,
      tag1: row.tag1,
      tag2: row.tag2,
      feedback_uri: row.feedback_uri,
      block_number: row.block_number,
      block_timestamp: row.block_timestamp,
      tx_hash: row.tx_hash,
      evidence: JSON.parse(row.evidence_json!) as SettlementEvidence
    }))
  };
}

function readA2AFieldsOf(row: FeedbackRow): { skill_ids: string[]; task_id: string | null } {
  const fields = row.file_json ? readA2AFields(JSON.parse(row.file_json) as Record<string, unknown>) : { skillIds: [], taskId: null };
  return { skill_ids: fields.skillIds, task_id: fields.taskId };
}

/** SQL for "distinct settled deals cited by distinct raters", the verified count. Same rule as `agentFeedbackCard`. */
export const VERIFIED_COUNT_SQL = `COUNT(DISTINCT CASE WHEN verification = 'settlement' AND revoked = 0
  THEN lower(client) || '|' || json_extract(evidence_json, '$.chainId') || '|' || lower(json_extract(evidence_json, '$.contract')) || '|' || json_extract(evidence_json, '$.dealId')
  END)`;

/** Agents on a registry with at least one verified entry, with the name each declares, if read. Derived, never a sign-up. */
export function listVerifiedAgents(db: SinettiDatabase, registry: RegistryConfig): Array<{ agent_id: string; name: string | null; verified: number; total: number }> {
  return db.prepare(`
    SELECT f.agent_id, a.name, f.verified, f.total FROM (
      SELECT agent_id, ${VERIFIED_COUNT_SQL} AS verified, COUNT(*) AS total
      FROM erc8004_feedback WHERE registry_chain_id = ? AND registry = ?
      GROUP BY agent_id HAVING verified > 0
    ) f
    LEFT JOIN erc8004_agents a ON a.registry_chain_id = ? AND a.registry = ? AND a.agent_id = f.agent_id
    ORDER BY CAST(f.agent_id AS INTEGER)
  `).all(registry.chainId, getAddress(registry.reputationRegistry), registry.chainId, getAddress(registry.identityRegistry)) as Array<{ agent_id: string; name: string | null; verified: number; total: number }>;
}
