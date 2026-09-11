/**
 * The ERC-8004 directory: who is registered, and what each agent says about itself.
 *
 * The Identity Registry is an ERC-721. `Registered` gives an agentId, its
 * owner and a registration URI; `URIUpdated` moves the URI. The file behind it
 * (name, description, services such as an A2A agent card or an MCP endpoint)
 * and the A2A agent card behind that (skills, capabilities, signatures) are
 * both written by the agent about itself, and neither has an on-chain hash.
 * Everything here that comes from those files is a declaration. It is shown
 * with the time it was read and never feeds a score; the score side lives in
 * `feedback.ts` and only counts what a counterparty could prove.
 *
 * Files are fetched in a batch pass under the same rules as feedback files
 * (https, ipfs or inline data URI, 64 KB, no redirects, no private hosts) and never at request
 * time. Every agent is re-read after `refreshAfter` seconds, or at once when
 * its URI moves, so a page is at most a day behind what the agent publishes.
 */
import { Interface, JsonRpcProvider, Log, Provider, getAddress } from "ethers";
import { SinettiDatabase, getSyncCheckpoint } from "./db";
import { REPAIR_PASSES, getLogsRetryingEmpty, getLogsSliced, holeOnCooldown, sequenceHoles, topicOf } from "./logs";
import {
  AgentFeedbackCard, Fetcher, FileStatus, VERIFIED_COUNT_SQL, VerifiedEntry, agentFeedbackCard, fetchJsonDocument,
  nodeFetcher, resolveFeedbackUri
} from "./feedback";
import { IDENTITY_REGISTRY_EVENTS_ABI, RegistryConfig, registryCaip10 } from "./registries";

const iface = new Interface(IDENTITY_REGISTRY_EVENTS_ABI);
const ID_SLICE = 500;

export interface AgentRow {
  registry_chain_id: number;
  registry: string;
  agent_id: string;
  owner: string;
  agent_uri: string;
  registered_block: number;
  registered_at: number;
  uri_block: number;
  file_status: FileStatus;
  file_json: string | null;
  name: string | null;
  active: number | null;
  fetched_at: number | null;
  card_url: string | null;
  card_status: FileStatus | null;
  card_json: string | null;
  card_fetched_at: number | null;
}

// ---------------------------------------------------------------------------
// 1. Events

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got: ${value}`);
  return value;
}

export interface IndexIdentityOptions {
  provider?: Provider;
  toBlock?: number;
  chunkSize?: number;
}

/**
 * Record registrations and URI changes from the identity registry's creation
 * block (or the last checkpoint) to the confirmed tip. A URI change puts the
 * agent back to `pending` so the next check pass re-reads it.
 */
export async function indexRegistryIdentity(
  db: SinettiDatabase,
  registry: RegistryConfig,
  options: IndexIdentityOptions = {}
): Promise<{ fromBlock: number; toBlock: number; registered: number; updated: number; repaired: number; missing: number }> {
  const chunkSize = positiveInteger("LOG_CHUNK_SIZE", options.chunkSize ?? Number(process.env.LOG_CHUNK_SIZE ?? 2_000));
  const provider = options.provider ?? new JsonRpcProvider(registry.rpcUrl, registry.chainId, { staticNetwork: true });
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== registry.chainId) {
    throw new Error(`RPC chain ${network.chainId} does not match registry ${registry.name} (${registry.chainId})`);
  }
  const address = getAddress(registry.identityRegistry);
  if ((await provider.getCode(address)) === "0x") {
    throw new Error(`No contract code at ${address} on chain ${registry.chainId}; refusing to index an identity registry that is not there`);
  }

  const checkpoint = getSyncCheckpoint(db, registry.name, address);
  const confirmedTip = (await provider.getBlockNumber()) - registry.confirmations;
  const latest = Math.min(options.toBlock ?? confirmedTip, confirmedTip);
  const start = checkpoint ? Math.max(registry.identityFromBlock, checkpoint.block + 1) : registry.identityFromBlock;
  if (start > latest) return { fromBlock: start, toBlock: latest, registered: 0, updated: 0, repaired: 0, missing: 0 };

  const insert = db.prepare(`
    INSERT OR IGNORE INTO erc8004_agents (registry_chain_id, registry, agent_id, owner, agent_uri, registered_block, registered_at, uri_block)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const move = db.prepare(`
    UPDATE erc8004_agents SET agent_uri = ?, uri_block = ?, file_status = 'pending'
    WHERE registry_chain_id = ? AND registry = ? AND agent_id = ? AND uri_block <= ?
  `);
  const checkpointWrite = db.prepare(`
    INSERT INTO sync_state (deployment, contract, last_indexed_block, last_indexed_block_hash)
    VALUES (?, ?, ?, NULL)
    ON CONFLICT(deployment, contract) DO UPDATE SET last_indexed_block = excluded.last_indexed_block
  `);

  let registered = 0;
  let updated = 0;
  const topics: string[] = [];
  iface.forEachEvent((event) => topics.push(event.topicHash));

  async function ingest(logs: Log[], checkpointTo: number | null): Promise<void> {
    const timestamps = new Map<number, number>();
    const rows: Array<() => number> = [];
    for (const log of logs) {
      const parsed = iface.parseLog(log);
      if (!parsed) continue;
      const agentId = String(parsed.args.agentId);
      if (parsed.name === "URIUpdated") {
        updated += 1;
        const uri = String(parsed.args.newURI);
        rows.push(() => (move.run(uri, log.blockNumber, registry.chainId, address, agentId, log.blockNumber), 0));
        continue;
      }
      let timestamp = timestamps.get(log.blockNumber);
      if (timestamp === undefined) {
        const block = await provider.getBlock(log.blockNumber);
        if (!block) throw new Error(`Missing block ${log.blockNumber}`);
        timestamp = block.timestamp;
        timestamps.set(log.blockNumber, timestamp);
      }
      const owner = getAddress(String(parsed.args.owner));
      const uri = String(parsed.args.agentURI);
      rows.push(() => insert.run(registry.chainId, address, agentId, owner, uri, log.blockNumber, timestamp, log.blockNumber).changes);
    }
    db.transaction(() => {
      for (const write of rows) registered += write();
      if (checkpointTo !== null) checkpointWrite.run(registry.name, address, checkpointTo);
    })();
  }

  for (let from = start; from <= latest; from += chunkSize) {
    const to = Math.min(from + chunkSize - 1, latest);
    await ingest(await getLogsRetryingEmpty(provider, { address, fromBlock: from, toBlock: to, topics: [topics] }), to);
  }

  // The registry is an ERC-721 minting ids in sequence (the reference contract from 0), so a
  // hole in the known ids is a window some RPC answered empty. Each hole is re-asked by
  // indexed agentId between its neighbours' blocks, then left alone for an hour so a watch
  // loop does not re-ask an unrecoverable hole every tick. ponytail: ids above the highest
  // known one are invisible here; the next scan sees them once a higher id lands.
  let repaired = 0;
  for (let pass = 0; pass < REPAIR_PASSES; pass += 1) {
    const holes = identityHoles(db, registry).filter((hole) => pass > 0 || !holeOnCooldown(`${registry.name}:id:${hole.from}-${hole.to}`));
    if (holes.length === 0) break;
    for (const hole of holes) {
      // Topic lists are capped per call; a wide hole is re-asked in slices of ids.
      for (let first = hole.from; first <= hole.to; first += ID_SLICE) {
        const ids: string[] = [];
        for (let id = first; id <= Math.min(first + ID_SLICE - 1, hole.to); id += 1) ids.push(topicOf(BigInt(id)));
        const before = registered;
        await ingest(await getLogsSliced(provider, { address, fromBlock: hole.fromBlock, toBlock: hole.toBlock, topics: [topics, ids] }), null);
        repaired += registered - before;
      }
    }
  }
  const missing = countMissingAgents(db, registry);
  return { fromBlock: start, toBlock: latest, registered, updated, repaired, missing };
}

/** Holes in the registry's agentId sequence, each with the block window that must hold it. */
export function identityHoles(db: SinettiDatabase, registry: RegistryConfig): ReturnType<typeof sequenceHoles> {
  const known = db.prepare(
    "SELECT CAST(agent_id AS INTEGER) AS position, registered_block AS block FROM erc8004_agents "
      + "WHERE registry_chain_id = ? AND registry = ? ORDER BY position"
  ).all(registry.chainId, getAddress(registry.identityRegistry)) as Array<{ position: number; block: number }>;
  return sequenceHoles(known, registry.firstAgentId ?? 0, registry.identityFromBlock);
}

/** Agent ids the index should hold and does not. Zero means the identity scan is complete up to its checkpoint. */
export function countMissingAgents(db: SinettiDatabase, registry: RegistryConfig): number {
  return identityHoles(db, registry).reduce((sum, hole) => sum + hole.to - hole.from + 1, 0);
}

// ---------------------------------------------------------------------------
// 2. Files

const NAME_LIMIT = 120;
const TEXT_LIMIT = 1_000;
const URI_LIMIT = 512;
const LIST_LIMIT = 50;

function text(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, LIST_LIMIT) : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export interface DeclaredService {
  name: string;
  endpoint: string;
  version: string | null;
}

/** What a registration file says. Every field optional; nothing here is checked. */
export interface Registration {
  name: string | null;
  description: string | null;
  image: string | null;
  active: boolean | null;
  services: DeclaredService[];
  /** The key the file used. The spec says `services`; early files said `endpoints`. */
  services_key: "services" | "endpoints" | null;
  supported_trust: string[];
  registrations: Array<{ agent_id: string | null; agent_registry: string | null }>;
}

export function readRegistration(file: Record<string, unknown>): Registration {
  const servicesKey = Array.isArray(file.services) ? "services" : Array.isArray(file.endpoints) ? "endpoints" : null;
  const services: DeclaredService[] = [];
  for (const entry of list(servicesKey ? file[servicesKey] : [])) {
    const service = record(entry);
    const name = service && text(service.name, NAME_LIMIT);
    const endpoint = service && text(service.endpoint, URI_LIMIT);
    if (name && endpoint) services.push({ name, endpoint, version: text(service.version, NAME_LIMIT) });
  }
  return {
    name: text(file.name, NAME_LIMIT),
    description: text(file.description, TEXT_LIMIT),
    image: text(file.image, URI_LIMIT),
    active: bool(file.active),
    services,
    services_key: servicesKey,
    supported_trust: list(file.supportedTrust).map((value) => text(value, NAME_LIMIT)).filter((value): value is string => !!value),
    registrations: list(file.registrations).map((entry) => {
      const registration = record(entry);
      const agentId = registration?.agentId;
      return {
        agent_id: Number.isSafeInteger(agentId) ? String(agentId) : text(agentId, 78),
        agent_registry: registration ? text(registration.agentRegistry, URI_LIMIT) : null
      };
    })
  };
}

/** The A2A card URL a registration points at, if it names an A2A service with a fetchable endpoint. */
export function agentCardUrl(registration: Registration): string | null {
  const service = registration.services.find((entry) => entry.name.toUpperCase() === "A2A");
  if (!service) return null;
  return "url" in resolveFeedbackUri(service.endpoint) ? service.endpoint : null;
}

export interface DeclaredSkill {
  id: string;
  name: string | null;
  description: string | null;
  tags: string[];
}

/** What an A2A agent card says. Read for display; a signature's presence is recorded and left unverified. */
export interface AgentCardSummary {
  name: string | null;
  description: string | null;
  url: string | null;
  provider: { organization: string | null; url: string | null } | null;
  version: string | null;
  protocol_version: string | null;
  capabilities: { streaming: boolean | null; push_notifications: boolean | null };
  skills: DeclaredSkill[];
  input_modes: string[];
  output_modes: string[];
  security_schemes: string[];
  signed: boolean;
}

export function readAgentCard(file: Record<string, unknown>): AgentCardSummary {
  const provider = record(file.provider);
  const capabilities = record(file.capabilities) ?? {};
  const schemes = record(file.securitySchemes);
  const strings = (value: unknown) => list(value).map((entry) => text(entry, NAME_LIMIT)).filter((entry): entry is string => !!entry);
  return {
    name: text(file.name, NAME_LIMIT),
    description: text(file.description, TEXT_LIMIT),
    url: text(file.url, URI_LIMIT),
    provider: provider ? { organization: text(provider.organization, NAME_LIMIT), url: text(provider.url, URI_LIMIT) } : null,
    version: text(file.version, NAME_LIMIT),
    protocol_version: text(file.protocolVersion, NAME_LIMIT),
    capabilities: { streaming: bool(capabilities.streaming), push_notifications: bool(capabilities.pushNotifications) },
    skills: list(file.skills).flatMap((entry) => {
      const skill = record(entry);
      const id = skill && text(skill.id, NAME_LIMIT);
      return id ? [{ id, name: text(skill.name, NAME_LIMIT), description: text(skill.description, TEXT_LIMIT), tags: strings(skill.tags) }] : [];
    }),
    input_modes: strings(file.defaultInputModes),
    output_modes: strings(file.defaultOutputModes),
    security_schemes: schemes ? Object.keys(schemes).slice(0, LIST_LIMIT).map((key) => key.slice(0, NAME_LIMIT)) : [],
    signed: Array.isArray(file.signatures) && file.signatures.length > 0
  };
}

export interface CheckAgentsOptions {
  fetcher?: Fetcher;
  /** Rows per call. */
  limit?: number;
  now?: () => number;
  /** Seconds after which a read file is read again. Default one day. */
  refreshAfter?: number;
  /** Files in flight at once. Default eight. */
  concurrency?: number;
}

/**
 * Fetch registration files and agent cards for agents never read, or read
 * more than `refreshAfter` seconds ago. Every status is re-tried on the same
 * schedule: an agent that fixes its file shows up within a day.
 */
export async function checkAgentFiles(db: SinettiDatabase, registry: RegistryConfig, options: CheckAgentsOptions = {}): Promise<number> {
  const fetcher = options.fetcher ?? nodeFetcher;
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  const address = getAddress(registry.identityRegistry);
  const staleBefore = now() - (options.refreshAfter ?? 86_400);
  const due = db.prepare(`
    SELECT registry_chain_id, registry, agent_id, agent_uri, uri_block FROM erc8004_agents
    WHERE registry_chain_id = ? AND registry = ? AND (file_status = 'pending' OR fetched_at < ?)
    ORDER BY file_status != 'pending', fetched_at IS NOT NULL, fetched_at, registered_block ${options.limit ? `LIMIT ${positiveInteger("limit", options.limit)}` : ""}
  `).all(registry.chainId, address, staleBefore) as Array<Pick<AgentRow, "registry_chain_id" | "registry" | "agent_id" | "agent_uri" | "uri_block">>;
  // Keyed on uri_block as well: if the URI moved while the old one was in
  // flight, the result belongs to a document nobody points at any more and
  // the row stays pending for the new one.
  const record = db.prepare(`
    UPDATE erc8004_agents SET file_status = ?, file_json = ?, name = ?, active = ?, fetched_at = ?,
      card_url = ?, card_status = ?, card_json = ?, card_fetched_at = ?
    WHERE registry_chain_id = ? AND registry = ? AND agent_id = ? AND uri_block = ?
  `);
  const concurrency = positiveInteger("concurrency", options.concurrency ?? 8);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const row = due[next++];
      if (!row) return;
      const file = await fetchJsonDocument(row.agent_uri, fetcher);
      const registration = file.json ? readRegistration(file.json) : null;
      const cardUrl = registration ? agentCardUrl(registration) : null;
      const card = cardUrl ? await fetchJsonDocument(cardUrl, fetcher) : null;
      const readAt = now();
      record.run(
        file.status, file.json ? JSON.stringify(file.json) : null, registration?.name ?? null,
        registration?.active === null || registration === null ? null : Number(registration.active), readAt,
        cardUrl, card?.status ?? null, card?.json ? JSON.stringify(card.json) : null, card ? readAt : null,
        row.registry_chain_id, row.registry, row.agent_id, row.uri_block
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
  return due.length;
}

// ---------------------------------------------------------------------------
// Cards

export type IdentityFlag = "registrations_missing" | "card_host_mismatch" | "legacy_endpoints_key";

export interface IdentityCard {
  agent_id: string;
  owner: string;
  agent_uri: string;
  registered_at: number;
  file_status: FileStatus;
  fetched_at: number | null;
  declared: Registration | null;
  card_url: string | null;
  card_status: FileStatus | null;
  card_fetched_at: number | null;
  card: AgentCardSummary | null;
  flags: IdentityFlag[];
}

function hostOf(uri: string | null): string | null {
  if (!uri) return null;
  try {
    return new URL(uri).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function identityFlags(registry: RegistryConfig, agentId: string, declared: Registration | null, cardUrl: string | null, card: AgentCardSummary | null): IdentityFlag[] {
  const flags: IdentityFlag[] = [];
  if (!declared) return flags;
  const identityCaip10 = `eip155:${registry.chainId}:${getAddress(registry.identityRegistry)}`.toLowerCase();
  const named = declared.registrations.some((entry) =>
    entry.agent_id === agentId && (entry.agent_registry === null || entry.agent_registry.toLowerCase() === identityCaip10)
  );
  if (!named) flags.push("registrations_missing");
  if (declared.services_key === "endpoints") flags.push("legacy_endpoints_key");
  const cardHost = hostOf(card?.url ?? null);
  const serviceHost = hostOf(cardUrl);
  if (cardHost && serviceHost && cardHost !== serviceHost) flags.push("card_host_mismatch");
  return flags;
}

export function agentIdentity(db: SinettiDatabase, registry: RegistryConfig, agentId: string): IdentityCard | null {
  const row = db.prepare("SELECT * FROM erc8004_agents WHERE registry_chain_id = ? AND registry = ? AND agent_id = ?")
    .get(registry.chainId, getAddress(registry.identityRegistry), agentId) as AgentRow | undefined;
  if (!row) return null;
  const declared = row.file_json ? readRegistration(JSON.parse(row.file_json) as Record<string, unknown>) : null;
  const card = row.card_json ? readAgentCard(JSON.parse(row.card_json) as Record<string, unknown>) : null;
  return {
    agent_id: row.agent_id,
    owner: row.owner,
    agent_uri: row.agent_uri,
    registered_at: row.registered_at,
    file_status: row.file_status,
    fetched_at: row.fetched_at,
    declared,
    card_url: row.card_url,
    card_status: row.card_status,
    card_fetched_at: row.card_fetched_at,
    card,
    flags: identityFlags(registry, agentId, declared, row.card_url, card)
  };
}

export interface NamedSkill {
  id: string;
  /** From the agent card; null when the card does not list this id. */
  name: string | null;
}

export type AgentCard = Omit<AgentFeedbackCard, "entries"> & {
  identity: IdentityCard | null;
  entries: Array<VerifiedEntry & { skills: NamedSkill[] }>;
};

/**
 * One card per agentId: the feedback side (verified ratings, counts) and the
 * identity side (what the agent declares). Null only when the registry has
 * never seen the agent on either side.
 */
export function agentCard(db: SinettiDatabase, registry: RegistryConfig, agentId: string): AgentCard | null {
  const identity = agentIdentity(db, registry, agentId);
  const feedback = agentFeedbackCard(db, registry, agentId) ?? (identity ? {
    registry: registryCaip10(registry),
    agent_id: agentId,
    feedback: { total: 0, revoked: 0, unchecked: 0, verified: 0, duplicates: 0 },
    verified_score: null,
    verified_clients: [],
    entries: []
  } : null);
  if (!feedback) return null;
  const skillNames = new Map((identity?.card?.skills ?? []).map((skill) => [skill.id, skill.name]));
  return {
    ...feedback,
    identity,
    entries: feedback.entries.map((entry) => ({
      ...entry,
      skills: entry.skill_ids.map((id) => ({ id, name: skillNames.get(id) ?? null }))
    }))
  };
}

export interface DirectoryRow {
  agent_id: string;
  name: string | null;
  active: boolean | null;
  file_status: FileStatus;
  verified: number;
  total: number;
}

type DirectoryRawRow = Omit<DirectoryRow, "active"> & { active: number | null };

// ponytail: the verified count is aggregated over the whole feedback table on
// every directory page and every search, once per registry. Fine at thousands
// of rows; keep a verified/total counter on erc8004_agents, updated by the
// feedback checker, if a registry grows past what one synchronous scan allows.
const DIRECTORY_SELECT = `
  SELECT a.agent_id, a.name, a.active, a.file_status, COALESCE(f.verified, 0) AS verified, COALESCE(f.total, 0) AS total
  FROM erc8004_agents a
  LEFT JOIN (
    SELECT agent_id, ${VERIFIED_COUNT_SQL} AS verified, COUNT(*) AS total
    FROM erc8004_feedback WHERE registry_chain_id = ? AND registry = ? GROUP BY agent_id
  ) f ON f.agent_id = a.agent_id
  WHERE a.registry_chain_id = ? AND a.registry = ?
`;
const DIRECTORY_ORDER = "ORDER BY verified DESC, total DESC, CAST(a.agent_id AS INTEGER)";

function directoryRow(row: DirectoryRawRow): DirectoryRow {
  return { ...row, active: row.active === null ? null : row.active === 1 };
}

export const DIRECTORY_PAGE_SIZE = 100;

/** Every registered agent, most verified first. `page` starts at 1. */
export function listAgentDirectory(db: SinettiDatabase, registry: RegistryConfig, page = 1): { page: number; pages: number; agents: DirectoryRow[] } {
  const reputation = getAddress(registry.reputationRegistry);
  const identity = getAddress(registry.identityRegistry);
  const count = (db.prepare("SELECT COUNT(*) AS n FROM erc8004_agents WHERE registry_chain_id = ? AND registry = ?")
    .get(registry.chainId, identity) as { n: number }).n;
  const pages = Math.max(1, Math.ceil(count / DIRECTORY_PAGE_SIZE));
  const current = Math.min(Math.max(1, Math.floor(page)), pages);
  const agents = db.prepare(`${DIRECTORY_SELECT} ${DIRECTORY_ORDER} LIMIT ? OFFSET ?`)
    .all(registry.chainId, reputation, registry.chainId, identity, DIRECTORY_PAGE_SIZE, (current - 1) * DIRECTORY_PAGE_SIZE) as DirectoryRawRow[];
  return { page: current, pages, agents: agents.map(directoryRow) };
}

export const SEARCH_LIMIT = 50;

/** Agents whose declared name equals `name` exactly, ignoring ASCII case. Uncapped: the lookup box redirects on exactly one. */
export function agentsNamed(db: SinettiDatabase, registry: RegistryConfig, name: string): string[] {
  const needle = name.trim().slice(0, NAME_LIMIT);
  if (!needle) return [];
  return (db.prepare("SELECT agent_id FROM erc8004_agents WHERE registry_chain_id = ? AND registry = ? AND name = ? COLLATE NOCASE ORDER BY CAST(agent_id AS INTEGER)")
    .all(registry.chainId, getAddress(registry.identityRegistry), needle) as Array<{ agent_id: string }>).map((row) => row.agent_id);
}

/**
 * Agents whose declared name contains `query`, ignoring ASCII case (SQLite's
 * LIKE folds a-z only; "Müller" and "müller" differ). Names are self-declared
 * and not unique.
 */
export function searchAgents(db: SinettiDatabase, registry: RegistryConfig, query: string): DirectoryRow[] {
  const needle = query.trim().slice(0, NAME_LIMIT);
  if (!needle) return [];
  const escaped = needle.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  const agents = db.prepare(`${DIRECTORY_SELECT} AND a.name LIKE ? ESCAPE '\\' ${DIRECTORY_ORDER} LIMIT ${SEARCH_LIMIT}`)
    .all(registry.chainId, getAddress(registry.reputationRegistry), registry.chainId, getAddress(registry.identityRegistry), `%${escaped}%`) as DirectoryRawRow[];
  return agents.map(directoryRow);
}
