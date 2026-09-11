import { expect } from "chai";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLastIndexedBlock, getSyncCheckpoint, openDatabase } from "../src/db";

describe("database migrations", function () {
  it("rejects the pre-contract indexer schema with an actionable reset message", function () {
    const directory = mkdtempSync(join(tmpdir(), "sinetti-rep-old-schema-"));
    const path = join(directory, "legacy.db");

    try {
      const legacyDb = new Database(path);
      legacyDb.exec(`
        CREATE TABLE deals (
          deployment TEXT NOT NULL,
          chain_id INTEGER NOT NULL,
          deal_id TEXT NOT NULL,
          PRIMARY KEY (deployment, deal_id)
        );
      `);
      legacyDb.close();

      expect(() => openDatabase(path)).to.throw(
        `sinetti-rep database schema changed (deals/raw_events/sync_state are now keyed by contract address). Delete ${path} and reindex from scratch.`
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a legacy sync_state table even when deals has the expected columns", function () {
    const directory = mkdtempSync(join(tmpdir(), "sinetti-rep-old-sync-state-"));
    const path = join(directory, "legacy.db");

    try {
      const legacyDb = new Database(path);
      legacyDb.exec(`
        CREATE TABLE deals (
          contract TEXT NOT NULL,
          block_number INTEGER NOT NULL
        );
        CREATE TABLE sync_state (
          deployment TEXT PRIMARY KEY,
          last_indexed_block INTEGER NOT NULL,
          last_indexed_block_hash TEXT
        );
      `);
      legacyDb.close();

      expect(() => openDatabase(path)).to.throw(
        `sinetti-rep database schema changed (deals/raw_events/sync_state are now keyed by contract address). Delete ${path} and reindex from scratch.`
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps deals and sync checkpoints independent across contracts in one deployment", function () {
    const db = openDatabase(":memory:");
    const firstContract = "0x0000000000000000000000000000000000000001";
    const secondContract = "0x0000000000000000000000000000000000000002";
    const commonDeal = {
      deployment: "sepolia",
      chainId: 11155111,
      dealId: "1",
      blockNumber: 100,
      buyer: "0x0000000000000000000000000000000000000011",
      seller: "0x0000000000000000000000000000000000000012",
      arbiter: "0x0000000000000000000000000000000000000013",
      verifier: "0x0000000000000000000000000000000000000014",
      token: "0x0000000000000000000000000000000000000015",
      amount: "100",
      bond: "0",
      criteriaHash: `0x${"00".repeat(32)}`,
      deadline: 2_000_000_000,
      fundedAt: 1_700_000_000
    };

    const insertDeal = db.prepare(`
      INSERT INTO deals (
        deployment, chain_id, contract, deal_id, block_number, buyer, seller, arbiter, verifier,
        token, token_decimals, amount, bond, criteria_hash, deadline, funded_at
      ) VALUES (
        @deployment, @chainId, @contract, @dealId, @blockNumber, @buyer, @seller, @arbiter, @verifier,
        @token, 6, @amount, @bond, @criteriaHash, @deadline, @fundedAt
      )
    `);
    insertDeal.run({ ...commonDeal, contract: firstContract });
    insertDeal.run({ ...commonDeal, contract: secondContract });

    expect(db.prepare("SELECT contract FROM deals WHERE deployment = ? AND contract = ? AND deal_id = ?")
      .get("sepolia", firstContract, "1")).to.deep.equal({ contract: firstContract });
    expect(db.prepare("SELECT contract FROM deals WHERE deployment = ? AND contract = ? AND deal_id = ?")
      .get("sepolia", secondContract, "1")).to.deep.equal({ contract: secondContract });
    expect(db.prepare("SELECT COUNT(*) AS count FROM deals").get()).to.deep.equal({ count: 2 });

    db.prepare(`
      INSERT INTO sync_state (deployment, contract, last_indexed_block, last_indexed_block_hash)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `).run("sepolia", firstContract, 101, "0xfirst", "sepolia", secondContract, 202, "0xsecond");
    expect(getLastIndexedBlock(db, "sepolia", firstContract)).to.equal(101);
    expect(getLastIndexedBlock(db, "sepolia", secondContract)).to.equal(202);
    expect(getSyncCheckpoint(db, "sepolia", firstContract)).to.deep.equal({ block: 101, hash: "0xfirst" });
    expect(getSyncCheckpoint(db, "sepolia", secondContract)).to.deep.equal({ block: 202, hash: "0xsecond" });
    db.close();
  });
});
