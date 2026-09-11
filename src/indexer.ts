import { Contract, Interface, JsonRpcProvider, Log, Provider, getAddress } from "ethers";
import { ERC20_ABI, SINETTI_ESCROW_V04_ABI } from "./abi";
import { DeploymentConfig } from "./config";
import { SinettiDatabase, StoredDeal, StoredEvent, getSyncCheckpoint } from "./db";
import { getLogsRetryingEmpty, getLogsSliced, holeOnCooldown, sequenceHoles, topicOf } from "./logs";

const iface = new Interface(SINETTI_ESCROW_V04_ABI);

/**
 * A misconfiguration rather than a transient fault. Retrying cannot resolve it,
 * because the chain will keep serving the same answer, so watch mode must exit
 * rather than poll forever behind an ever-growing backoff.
 */
export class UnsupportedDeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedDeploymentError";
  }
}

/**
 * Refuses an address with no contract code, at startup and on every watch poll.
 *
 * This is the guard that has to exist once the escrow speaks one vocabulary,
 * because the failure it catches is silent. Point the indexer at the wrong
 * address and no topic matches, so no logs are fetched, so the run reports zero
 * events and looks healthy: "no contract here" and "nothing has happened yet"
 * become indistinguishable, which is the absence-vs-zero confusion in its
 * purest form.
 *
 * The chainId check below cannot cover it: two nodes of the same network
 * announce the same chain id, so a deployment pointed at a node where the
 * escrow was never deployed passes that check and then indexes a chain where
 * its escrow has no code. The contract address is the real discriminator, and
 * this reads it.
 */
async function assertContractPresent(
  provider: Provider,
  deployment: DeploymentConfig,
  contract: string
): Promise<void> {
  const code = await provider.getCode(contract);
  if (code !== "0x") return;
  throw new UnsupportedDeploymentError(
    `Refusing to index ${deployment.name}: no contract code at ${contract} on chain ` +
      `${deployment.chainId}. Indexing would return zero events and look healthy rather ` +
      "than failing, so it stops here. Check the deployment's address and RPC URL: two nodes " +
      "of one network share a chain id, and only the address tells them apart."
  );
}

const REORG_HISTORY_DEPTH = 200;
const MAX_CHUNK_READ_ATTEMPTS = 5;

type Checkpoint = { block: number; hash: string };

export interface IndexOptions {
  provider?: Provider;
  toBlock?: number;
  chunkSize?: number;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
  return value;
}

function jsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonValue);
  return value;
}

/**
 * A V04 identity-ref slot as the deal projection stores it, or null.
 *
 * Null is reserved for "this vocabulary has no such field", meaning V02, where the
 * event carries nothing to read. A V04 deal whose slot is unfilled keeps its
 * zero hash instead, because "the escrow had nowhere to record an identity" and
 * "the escrow had somewhere and it was left empty" are different facts, and the
 * second is the one that says the write path is not wired yet.
 */
function identityRef(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("0x") ? value.toLowerCase() : null;
}

async function tokenDecimals(provider: Provider, token: string): Promise<number | null> {
  try {
    return Number(await new Contract(token, ERC20_ABI, provider).decimals());
  } catch {
    return null;
  }
}

async function reconcileCheckpoint(
  db: SinettiDatabase,
  deployment: DeploymentConfig,
  contract: string,
  provider: Provider,
  expectedBlock: number,
  expectedHash: string
): Promise<Checkpoint | null> {
  const checkpointBlock = await provider.getBlock(expectedBlock);
  if (checkpointBlock?.hash === expectedHash) return { block: expectedBlock, hash: expectedHash };

  const history = db.prepare(`
    SELECT block_number, block_hash
    FROM sync_checkpoint_history
    WHERE deployment = ? AND contract = ?
    ORDER BY block_number DESC
  `).all(deployment.name, contract) as Array<{ block_number: number; block_hash: string }>;
  let verified: Checkpoint | null = null;
  for (const stored of history) {
    const currentBlock = await provider.getBlock(stored.block_number);
    if (currentBlock?.hash === stored.block_hash) {
      verified = { block: stored.block_number, hash: stored.block_hash };
      break;
    }
  }

  db.transaction(() => {
    if (verified) {
      db.prepare(`
        DELETE FROM raw_events WHERE deployment = ? AND contract = ? AND block_number > ?
      `).run(deployment.name, contract, verified.block);
      db.prepare(`
        DELETE FROM deals WHERE deployment = ? AND contract = ? AND block_number > ?
      `).run(deployment.name, contract, verified.block);
      db.prepare(`
        DELETE FROM sync_checkpoint_history WHERE deployment = ? AND contract = ? AND block_number > ?
      `).run(deployment.name, contract, verified.block);
      db.prepare(`
        INSERT INTO sync_state (deployment, contract, last_indexed_block, last_indexed_block_hash)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(deployment, contract) DO UPDATE SET
          last_indexed_block=excluded.last_indexed_block,
          last_indexed_block_hash=excluded.last_indexed_block_hash
      `).run(deployment.name, contract, verified.block, verified.hash);
    } else {
      db.prepare("DELETE FROM raw_events WHERE deployment = ? AND contract = ?")
        .run(deployment.name, contract);
      db.prepare("DELETE FROM deals WHERE deployment = ? AND contract = ?")
        .run(deployment.name, contract);
      db.prepare("DELETE FROM sync_checkpoint_history WHERE deployment = ? AND contract = ?")
        .run(deployment.name, contract);
      db.prepare("DELETE FROM sync_state WHERE deployment = ? AND contract = ?")
        .run(deployment.name, contract);
    }
  })();
  return verified;
}

/** Decode escrow logs into event rows and the deal projection; one getBlock per block, one decimals read per token. */
async function decodeLogs(
  provider: Provider,
  deployment: DeploymentConfig,
  contract: string,
  logs: Log[]
): Promise<{ events: StoredEvent[]; deals: StoredDeal[] }> {
  const timestamps = new Map<number, number>();
  const decimals = new Map<string, number | null>();
  const events: StoredEvent[] = [];
  const deals: StoredDeal[] = [];

  for (const log of logs) {
    const parsed = iface.parseLog(log);
    if (!parsed) continue;
    let timestamp = timestamps.get(log.blockNumber);
    if (timestamp === undefined) {
      const block = await provider.getBlock(log.blockNumber);
      if (!block) throw new Error(`Missing block ${log.blockNumber}`);
      timestamp = block.timestamp;
      timestamps.set(log.blockNumber, timestamp);
    }
    const args = Object.fromEntries(parsed.fragment.inputs.map((input, index) => [input.name, jsonValue(parsed.args[index])]));
    const dealId = "dealId" in args ? String(args.dealId) : null;
    events.push({
      deployment: deployment.name,
      chain_id: deployment.chainId,
      contract,
      tx_hash: log.transactionHash,
      log_index: log.index,
      block_number: log.blockNumber,
      block_timestamp: timestamp,
      deal_id: dealId,
      event_name: parsed.name,
      args_json: JSON.stringify(args)
    });

    // The deal projection keeps only what the reputation card reads. The
    // remaining DealOpened fields (the two windows and the challenger bond)
    // stay in raw_events, so nothing is lost and the projection does not
    // carry columns no consumer reads.
    //
    // The four identity refs ARE projected, as of the identity-anchor work:
    // they are what lets a card say whether a counterparty's settled history
    // carries a recorded legal identity. A null column means the deal
    // predates the projection; V04's zero hash means the slot existed and
    // nobody filled it. Those are different facts and the card reports them
    // differently.
    //
    // `arbiter` and `criteria_hash` keep their column names from the retired
    // V02 schema, where the event called them that. Renaming them to V04's
    // `arbitrator` and `termsHash` would be a migration on every existing
    // database for a cosmetic gain, so the mapping happens here instead.
    if (parsed.name === "DealOpened") {
      const token = getAddress(String(args.token));
      let tokenDecimal: number | null;
      if (!decimals.has(token)) {
        tokenDecimal = await tokenDecimals(provider, token);
        decimals.set(token, tokenDecimal);
      } else {
        tokenDecimal = decimals.get(token)!;
      }
      deals.push({
        deployment: deployment.name,
        chain_id: deployment.chainId,
        contract,
        deal_id: String(args.dealId),
        block_number: log.blockNumber,
        buyer: getAddress(String(args.buyer)),
        seller: getAddress(String(args.seller)),
        arbiter: getAddress(String(args.arbitrator)),
        verifier: getAddress(String(args.verifier)),
        token,
        token_decimals: tokenDecimal,
        amount: String(args.amount),
        bond: String(args.bond),
        criteria_hash: String(args.termsHash),
        deadline: Number(args.deadline),
        funded_at: timestamp,
        buyer_identity_ref: identityRef(args.buyerIdentityRef),
        seller_identity_ref: identityRef(args.sellerIdentityRef)
      });
    }
  }
  return { events, deals };
}

/**
 * Deal ids are sequential from 1 and a deal that opened must eventually settle, so a hole
 * in the ids, or a deal with no `Settled` row, is either an open deal or a window a public
 * RPC answered empty. Both are re-asked by the indexed dealId topic; each is left alone for
 * an hour afterwards so an open deal does not cost a call every tick. Writes go through
 * the same idempotent inserts as the scan and never move the checkpoint.
 */
async function repairEscrowHoles(
  db: SinettiDatabase,
  deployment: DeploymentConfig,
  contract: string,
  provider: Provider,
  latest: number
): Promise<number> {
  const eventTopics: string[] = [];
  iface.forEachEvent((event) => eventTopics.push(event.topicHash));
  const known = db.prepare(
    "SELECT CAST(deal_id AS INTEGER) AS position, block_number AS block FROM deals WHERE deployment = ? AND contract = ? ORDER BY position"
  ).all(deployment.name, contract) as Array<{ position: number; block: number }>;
  const unsettled = db.prepare(
    "SELECT deal_id, block_number FROM deals d WHERE deployment = ? AND contract = ? AND NOT EXISTS ("
      + "SELECT 1 FROM raw_events e WHERE e.deployment = d.deployment AND e.contract = d.contract AND e.deal_id = d.deal_id AND e.event_name = 'Settled')"
  ).all(deployment.name, contract) as Array<{ deal_id: string; block_number: number }>;
  const asks: Array<{ key: string; ids: string[]; fromBlock: number }> = [];
  for (const hole of sequenceHoles(known, 1, deployment.fromBlock)) {
    const ids: string[] = [];
    for (let id = hole.from; id <= hole.to; id += 1) ids.push(topicOf(BigInt(id)));
    asks.push({ key: `${deployment.name}:deal:${hole.from}-${hole.to}`, ids, fromBlock: hole.fromBlock });
  }
  for (const deal of unsettled) {
    asks.push({ key: `${deployment.name}:unsettled:${deal.deal_id}`, ids: [topicOf(BigInt(deal.deal_id))], fromBlock: deal.block_number });
  }
  let repaired = 0;
  for (const ask of asks) {
    if (holeOnCooldown(ask.key)) continue;
    const logs = await getLogsSliced(provider, { address: contract, fromBlock: ask.fromBlock, toBlock: latest, topics: [eventTopics, ask.ids] });
    if (logs.length === 0) continue;
    const { events, deals } = await decodeLogs(provider, deployment, contract, logs);
    db.transaction(() => {
      const insertEvent = db.prepare(`
        INSERT OR IGNORE INTO raw_events
        (deployment, chain_id, contract, tx_hash, log_index, block_number, block_timestamp, deal_id, event_name, args_json)
        VALUES (@deployment, @chain_id, @contract, @tx_hash, @log_index, @block_number, @block_timestamp, @deal_id, @event_name, @args_json)
      `);
      const insertDeal = db.prepare(`
        INSERT OR IGNORE INTO deals
        (deployment, chain_id, contract, deal_id, block_number, buyer, seller, arbiter, verifier, token, token_decimals, amount, bond, criteria_hash, deadline, funded_at, buyer_identity_ref, seller_identity_ref)
        VALUES (@deployment, @chain_id, @contract, @deal_id, @block_number, @buyer, @seller, @arbiter, @verifier, @token, @token_decimals, @amount, @bond, @criteria_hash, @deadline, @funded_at, @buyer_identity_ref, @seller_identity_ref)
      `);
      for (const event of events) repaired += insertEvent.run(event).changes;
      for (const deal of deals) insertDeal.run(deal);
    })();
  }
  return repaired;
}

export async function indexDeployment(
  db: SinettiDatabase,
  deployment: DeploymentConfig,
  options: IndexOptions = {}
): Promise<{ fromBlock: number; toBlock: number; events: number; repaired: number }> {
  const chunkSize = positiveInteger(
    "LOG_CHUNK_SIZE",
    options.chunkSize ?? Number(process.env.LOG_CHUNK_SIZE ?? 2_000)
  );
  const provider = options.provider ?? new JsonRpcProvider(deployment.rpcUrl, deployment.chainId);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== deployment.chainId) {
    throw new Error(`RPC chain ${network.chainId} does not match ${deployment.name} (${deployment.chainId})`);
  }

  const contract = getAddress(deployment.contract);
  await assertContractPresent(provider, deployment, contract);
  let checkpoint = getSyncCheckpoint(db, deployment.name, contract);
  if (checkpoint?.hash) {
    checkpoint = await reconcileCheckpoint(
      db, deployment, contract, provider, checkpoint.block, checkpoint.hash
    );
  }

  const chainTip = await provider.getBlockNumber();
  const confirmedTip = chainTip - deployment.confirmations;
  const latest = Math.min(options.toBlock ?? confirmedTip, confirmedTip);
  const lastIndexed = checkpoint?.block ?? null;
  const start = Math.max(deployment.fromBlock, lastIndexed === null ? deployment.fromBlock : lastIndexed + 1);
  if (start > latest) {
    const repaired = await repairEscrowHoles(db, deployment, contract, provider, latest);
    return { fromBlock: start, toBlock: latest, events: 0, repaired };
  }

  let eventCount = 0;
  const countedChunks: Array<{ toBlock: number; events: number }> = [];
  let previousBoundary: Checkpoint | null = checkpoint?.hash
    ? { block: checkpoint.block, hash: checkpoint.hash }
    : null;
  let nextBlock = start;
  let chunkReadAttempts = 0;
  while (nextBlock <= latest) {
    const fromBlock = nextBlock;
    const toBlock = Math.min(fromBlock + chunkSize - 1, latest);
    chunkReadAttempts += 1;
    const chunkAnchorBlock = await provider.getBlock(toBlock);
    if (!chunkAnchorBlock?.hash) throw new Error(`Missing block ${toBlock}`);
    const chunkAnchorHash = chunkAnchorBlock.hash;
    const eventTopics: string[] = [];
    iface.forEachEvent((event) => eventTopics.push(event.topicHash));
    const logs = await getLogsRetryingEmpty(provider, {
      address: contract,
      fromBlock,
      toBlock,
      topics: [eventTopics]
    });
    const { events, deals } = await decodeLogs(provider, deployment, contract, logs);

    if (previousBoundary) {
      const reconciled = await reconcileCheckpoint(
        db, deployment, contract, provider, previousBoundary.block, previousBoundary.hash
      );
      if (
        !reconciled ||
        reconciled.block !== previousBoundary.block ||
        reconciled.hash !== previousBoundary.hash
      ) {
        while (countedChunks.at(-1) && countedChunks.at(-1)!.toBlock > (reconciled?.block ?? -1)) {
          eventCount -= countedChunks.pop()!.events;
        }
        previousBoundary = reconciled;
        nextBlock = reconciled ? reconciled.block + 1 : deployment.fromBlock;
        chunkReadAttempts = 0;
        continue;
      }
    }

    const persist = db.transaction(() => {
      const insertEvent = db.prepare(`
        INSERT OR IGNORE INTO raw_events
        (deployment, chain_id, contract, tx_hash, log_index, block_number, block_timestamp, deal_id, event_name, args_json)
        VALUES (@deployment, @chain_id, @contract, @tx_hash, @log_index, @block_number, @block_timestamp, @deal_id, @event_name, @args_json)
      `);
      const insertDeal = db.prepare(`
        INSERT INTO deals
        (deployment, chain_id, contract, deal_id, block_number, buyer, seller, arbiter, verifier, token, token_decimals, amount, bond, criteria_hash, deadline, funded_at, buyer_identity_ref, seller_identity_ref)
        VALUES (@deployment, @chain_id, @contract, @deal_id, @block_number, @buyer, @seller, @arbiter, @verifier, @token, @token_decimals, @amount, @bond, @criteria_hash, @deadline, @funded_at, @buyer_identity_ref, @seller_identity_ref)
        ON CONFLICT(deployment, contract, deal_id) DO UPDATE SET
          block_number=excluded.block_number,
          buyer=excluded.buyer, seller=excluded.seller, arbiter=excluded.arbiter, verifier=excluded.verifier,
          token=excluded.token, token_decimals=excluded.token_decimals, amount=excluded.amount,
          bond=excluded.bond, criteria_hash=excluded.criteria_hash, deadline=excluded.deadline, funded_at=excluded.funded_at,
          buyer_identity_ref=excluded.buyer_identity_ref, seller_identity_ref=excluded.seller_identity_ref
      `);
      for (const event of events) insertEvent.run(event);
      for (const deal of deals) insertDeal.run(deal);
      db.prepare(`
        INSERT INTO sync_state (deployment, contract, last_indexed_block, last_indexed_block_hash)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(deployment, contract) DO UPDATE SET
          last_indexed_block=excluded.last_indexed_block,
          last_indexed_block_hash=excluded.last_indexed_block_hash
      `).run(deployment.name, contract, toBlock, chunkAnchorHash);
      db.prepare(`
        INSERT INTO sync_checkpoint_history (deployment, contract, block_number, block_hash)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(deployment, contract, block_number) DO UPDATE SET block_hash=excluded.block_hash
      `).run(deployment.name, contract, toBlock, chunkAnchorHash);
      db.prepare(`
        DELETE FROM sync_checkpoint_history
        WHERE deployment = ? AND contract = ? AND block_number NOT IN (
          SELECT block_number FROM sync_checkpoint_history
          WHERE deployment = ? AND contract = ?
          ORDER BY block_number DESC
          LIMIT ?
        )
      `).run(deployment.name, contract, deployment.name, contract, REORG_HISTORY_DEPTH);
    });
    const verifiedChunkBlock = await provider.getBlock(toBlock);
    if (verifiedChunkBlock?.hash !== chunkAnchorHash) {
      if (chunkReadAttempts >= MAX_CHUNK_READ_ATTEMPTS) {
        throw new Error(`Block ${toBlock} changed during ${MAX_CHUNK_READ_ATTEMPTS} chunk read attempts`);
      }
      continue;
    }
    persist();
    eventCount += events.length;
    countedChunks.push({ toBlock, events: events.length });
    previousBoundary = { block: toBlock, hash: chunkAnchorHash };
    nextBlock = toBlock + 1;
    chunkReadAttempts = 0;
  }
  const repaired = await repairEscrowHoles(db, deployment, contract, provider, latest);
  return { fromBlock: start, toBlock: latest, events: eventCount, repaired };
}

export async function watchDeployment(
  db: SinettiDatabase,
  deployment: DeploymentConfig,
  intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 15_000)
): Promise<never> {
  positiveInteger("POLL_INTERVAL_MS", intervalMs);
  const chunkSize = positiveInteger("LOG_CHUNK_SIZE", Number(process.env.LOG_CHUNK_SIZE ?? 2_000));
  let retryDelayMs = Math.min(Math.max(intervalMs, 1_000), 60_000);
  for (;;) {
    try {
      await indexDeployment(db, deployment, { chunkSize });
      retryDelayMs = Math.min(Math.max(intervalMs, 1_000), 60_000);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    } catch (error) {
      // Retrying a misconfiguration just hides it behind a live-looking process.
      if (error instanceof UnsupportedDeploymentError) throw error;
      console.error(`Indexer poll failed for ${deployment.name}; retrying in ${retryDelayMs}ms`, error);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      retryDelayMs = Math.min(retryDelayMs * 2, 60_000);
    }
  }
}
