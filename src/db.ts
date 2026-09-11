import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { getAddress } from "ethers";

export type SinettiDatabase = Database.Database;

export interface StoredEvent {
  deployment: string;
  chain_id: number;
  contract: string;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_timestamp: number;
  deal_id: string | null;
  event_name: string;
  args_json: string;
}

export interface StoredDeal {
  deployment: string;
  chain_id: number;
  contract: string;
  deal_id: string;
  block_number: number;
  buyer: string;
  seller: string;
  arbiter: string;
  verifier: string;
  token: string;
  token_decimals: number | null;
  amount: string;
  bond: string;
  criteria_hash: string;
  deadline: number;
  funded_at: number;
  /**
   * The bytes32 identity anchors SinettiEscrowV04 carries per role, or null.
   *
   * Null means the vocabulary has no such field at all (V02); the zero hash
   * means V04 had the slot and nobody filled it. Those are different facts and
   * the card reports them differently, so they are not merged here either.
   */
  buyer_identity_ref?: string | null;
  seller_identity_ref?: string | null;
}

export function openDatabase(path = process.env.DATABASE_PATH ?? "./data/sinetti-rep.db"): SinettiDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const expectedIndexerColumns: Record<string, string[]> = {
    deals: ["contract", "block_number"],
    raw_events: ["contract"],
    sync_state: ["contract"]
  };
  for (const [table, expectedColumns] of Object.entries(expectedIndexerColumns)) {
    const existing = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (existing) {
      const columns = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)
      );
      if (expectedColumns.every((column) => columns.has(column))) continue;
      db.close();
      throw new Error(
        `sinetti-rep database schema changed (deals/raw_events/sync_state are now keyed by contract address). Delete ${path} and reindex from scratch.`
      );
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_events (
      deployment TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      contract TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      block_timestamp INTEGER NOT NULL,
      deal_id TEXT,
      event_name TEXT NOT NULL,
      args_json TEXT NOT NULL,
      PRIMARY KEY (deployment, contract, tx_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS raw_events_deal_idx
      ON raw_events (deployment, contract, deal_id, block_number, log_index);
    CREATE INDEX IF NOT EXISTS raw_events_block_idx
      ON raw_events (deployment, contract, block_number);
    CREATE TABLE IF NOT EXISTS deals (
      deployment TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      contract TEXT NOT NULL,
      deal_id TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      buyer TEXT NOT NULL,
      seller TEXT NOT NULL,
      arbiter TEXT NOT NULL,
      verifier TEXT NOT NULL,
      token TEXT NOT NULL,
      token_decimals INTEGER,
      amount TEXT NOT NULL,
      bond TEXT NOT NULL,
      criteria_hash TEXT NOT NULL,
      deadline INTEGER NOT NULL,
      funded_at INTEGER NOT NULL,
      buyer_identity_ref TEXT,
      seller_identity_ref TEXT,
      PRIMARY KEY (deployment, contract, deal_id)
    );
    CREATE INDEX IF NOT EXISTS deals_roles_idx ON deals (buyer, seller, arbiter, verifier);
    CREATE INDEX IF NOT EXISTS deals_reorg_idx ON deals (deployment, contract, block_number);
    CREATE TABLE IF NOT EXISTS sync_state (
      deployment TEXT NOT NULL,
      contract TEXT NOT NULL,
      last_indexed_block INTEGER NOT NULL,
      last_indexed_block_hash TEXT,
      PRIMARY KEY (deployment, contract)
    );
    CREATE TABLE IF NOT EXISTS sync_checkpoint_history (
      deployment TEXT NOT NULL,
      contract TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      block_hash TEXT NOT NULL,
      PRIMARY KEY (deployment, contract, block_number)
    );
    CREATE INDEX IF NOT EXISTS sync_checkpoint_history_recent_idx
      ON sync_checkpoint_history (deployment, contract, block_number DESC);
    /*
     * Which settled deals have already been written to an ERC-8004 Reputation
     * Registry. The primary key is the idempotency guard: publishing is a paid,
     * public, append-only write to somebody else's contract, and ERC-8004 has
     * no notion of "replace my previous feedback". A re-run without this table
     * would double-count the same deal in every consumer's summary, and no
     * later correction removes it.
     *
     * Keyed by registry as well as deal so the same history can be published to
     * a second chain without the first one blocking it.
     */
    CREATE TABLE IF NOT EXISTS erc8004_publications (
      registry_chain_id INTEGER NOT NULL,
      registry TEXT NOT NULL,
      deployment TEXT NOT NULL,
      contract TEXT NOT NULL,
      deal_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      value INTEGER NOT NULL,
      feedback_uri TEXT NOT NULL,
      tx_hash TEXT,
      published_at INTEGER,
      PRIMARY KEY (registry_chain_id, registry, deployment, contract, deal_id, subject)
    );
    /*
     * Every feedback event read from an ERC-8004 Reputation Registry, plus what
     * this instance found when it fetched the rater's file and checked its
     * settlement claim. One row per (registry, agentId, client, index), which
     * is the registry's own identity for an entry. file_status 'pending'
     * means not yet fetched; verification is 'settlement' only when the
     * claim checked out against indexed escrow history.
     */
    CREATE TABLE IF NOT EXISTS erc8004_feedback (
      registry_chain_id INTEGER NOT NULL,
      registry TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      client TEXT NOT NULL,
      feedback_index INTEGER NOT NULL,
      value TEXT NOT NULL,
      value_decimals INTEGER NOT NULL,
      tag1 TEXT NOT NULL,
      tag2 TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      feedback_uri TEXT NOT NULL,
      feedback_hash TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      block_timestamp INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      file_status TEXT NOT NULL DEFAULT 'pending',
      file_json TEXT,
      verification TEXT NOT NULL DEFAULT 'unverified',
      evidence_json TEXT,
      checked_at INTEGER,
      PRIMARY KEY (registry_chain_id, registry, agent_id, client, feedback_index)
    );
    CREATE INDEX IF NOT EXISTS erc8004_feedback_pending_idx
      ON erc8004_feedback (registry_chain_id, registry, file_status, block_number, log_index);
    /*
     * Every agent registered on an ERC-8004 Identity Registry, with what this
     * instance found at its registration URI and, when the file lists an A2A
     * service, at the agent card behind it. Both documents are written by the
     * agent about itself and carry no on-chain hash, so every column derived
     * from them is a declaration, recorded with the time it was read.
     * The registry column here is the identity registry address.
     */
    CREATE TABLE IF NOT EXISTS erc8004_agents (
      registry_chain_id INTEGER NOT NULL,
      registry TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      agent_uri TEXT NOT NULL,
      registered_block INTEGER NOT NULL,
      registered_at INTEGER NOT NULL,
      uri_block INTEGER NOT NULL,
      file_status TEXT NOT NULL DEFAULT 'pending',
      file_json TEXT,
      name TEXT,
      active INTEGER,
      fetched_at INTEGER,
      card_url TEXT,
      card_status TEXT,
      card_json TEXT,
      card_fetched_at INTEGER,
      PRIMARY KEY (registry_chain_id, registry, agent_id)
    );
    CREATE INDEX IF NOT EXISTS erc8004_agents_fetch_idx
      ON erc8004_agents (registry_chain_id, registry, file_status, fetched_at);
    CREATE INDEX IF NOT EXISTS erc8004_agents_name_idx
      ON erc8004_agents (registry_chain_id, registry, name);
  `);
  // A row is written BEFORE the transaction is sent (tx_hash and published_at
  // NULL), so a crash between sending and recording cannot lead to the same
  // deal being sent again. Databases created before this change declared both
  // columns NOT NULL; SQLite cannot relax a constraint in place, so rebuild.
  const publicationColumns = db.prepare("PRAGMA table_info(erc8004_publications)").all() as Array<{ name: string; notnull: number }>;
  if (publicationColumns.some((column) => column.name === "tx_hash" && column.notnull === 1)) {
    db.exec(`
      CREATE TABLE erc8004_publications_new AS SELECT * FROM erc8004_publications WHERE 0;
      DROP TABLE erc8004_publications_new;
      ALTER TABLE erc8004_publications RENAME TO erc8004_publications_old;
      CREATE TABLE erc8004_publications (
        registry_chain_id INTEGER NOT NULL,
        registry TEXT NOT NULL,
        deployment TEXT NOT NULL,
        contract TEXT NOT NULL,
        deal_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        value INTEGER NOT NULL,
        feedback_uri TEXT NOT NULL,
        tx_hash TEXT,
        published_at INTEGER,
        PRIMARY KEY (registry_chain_id, registry, deployment, contract, deal_id, subject)
      );
      INSERT INTO erc8004_publications SELECT * FROM erc8004_publications_old;
      DROP TABLE erc8004_publications_old;
    `);
  }
  // Added in place rather than through the reindex guard above: an existing
  // database has these as NULL, which is the truthful value for rows indexed
  // before anything read the slot. Forcing a full reindex to learn that every
  // historical deal has no anchor would buy nothing.
  const dealsColumns = new Set(
    (db.prepare("PRAGMA table_info(deals)").all() as Array<{ name: string }>).map((column) => column.name)
  );
  for (const column of ["buyer_identity_ref", "seller_identity_ref"]) {
    if (!dealsColumns.has(column)) db.exec(`ALTER TABLE deals ADD COLUMN ${column} TEXT`);
  }
  return db;
}

export function getLastIndexedBlock(db: SinettiDatabase, deployment: string, contract: string): number | null {
  const row = db.prepare("SELECT last_indexed_block FROM sync_state WHERE deployment = ? AND contract = ?")
    .get(deployment, getAddress(contract)) as
    | { last_indexed_block: number }
    | undefined;
  return row?.last_indexed_block ?? null;
}

export function getSyncCheckpoint(
  db: SinettiDatabase,
  deployment: string,
  contract: string
): { block: number; hash: string | null } | null {
  const row = db.prepare(`
    SELECT last_indexed_block, last_indexed_block_hash
    FROM sync_state
    WHERE deployment = ? AND contract = ?
  `).get(deployment, getAddress(contract)) as
    | { last_indexed_block: number; last_indexed_block_hash: string | null }
    | undefined;
  return row
    ? { block: row.last_indexed_block, hash: row.last_indexed_block_hash }
    : null;
}
