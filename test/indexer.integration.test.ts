import { expect } from "chai";
import { Contract, JsonRpcProvider, Provider, Signer, encodeBytes32String, getAddress, id } from "ethers";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { mock } from "node:test";
import { listSettledDeals, resolveDeal } from "../src/settlement";
import { forgetHoles } from "../src/logs";
import { DeploymentConfig } from "../src/config";
import { getLastIndexedBlock, getSyncCheckpoint, openDatabase } from "../src/db";
import { indexDeployment, watchDeployment } from "../src/indexer";

const CRITERIA = encodeBytes32String("criteria");
const EVIDENCE = encodeBytes32String("evidence");
const AMOUNT = 100_000_000n;
const BOND = 10_000_000n;

/** SinettiEscrowV04.Verdict ordinals: 0 None, 1 Pass, 2 Fail, 3 Inconclusive. */
const VERDICT_PASS = 1;
const VERDICT_FAIL = 2;

/** `Settled.reason` values, readable ASCII in an indexed bytes32. */
const REASON_VERDICT_PASS = encodeBytes32String("verdict_pass");
const REASON_RULING_RELEASE = encodeBytes32String("ruling_release");
const REASON_RULING_REFUND = encodeBytes32String("ruling_refund");

async function expectRejection(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
    expect.fail("Expected promise to reject");
  } catch (error) {
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.include(message);
  }
}

function providerWithReorg(
  verifiedAncestor: number,
  options: { dropLogs?: boolean } = {}
): Provider {
  return new Proxy(ethers.provider, {
    get(target, property) {
      if (property === "getBlock") {
        return async (blockTag: string | number) => {
          const block = await target.getBlock(blockTag);
          if (block && typeof blockTag === "number" && blockTag > verifiedAncestor) {
            return { ...block, hash: `0x${"ff".repeat(32)}` } as typeof block;
          }
          return block;
        };
      }
      if (property === "getLogs" && options.dropLogs) return async () => [];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as unknown as Provider;
}

/** The V04 `openDeal` struct, with the fields these tests do not vary defaulted. */
function openParams(overrides: {
  seller: string;
  verifier: string;
  arbitrator: string;
  token: string;
  amount: bigint;
  bond: bigint;
  deadline: bigint;
}) {
  return {
    challengerBond: 0n,
    termsHash: CRITERIA,
    challengeWindow: 0n,
    rulingWindow: 0n,
    ...overrides
  };
}

/** An address with contract code, for the tests that only need the indexer to start. */
async function deployEscrow(): Promise<Contract> {
  const escrow = (await (await ethers.getContractFactory("MockEscrowV04")).deploy()) as Contract;
  await escrow.waitForDeployment();
  return escrow;
}

async function deployRecentFundedDeal(
  name: string,
  blocksBeforeDeal = 70
): Promise<{ deployment: DeploymentConfig; dealBlock: number }> {
  const [buyer, seller, arbiter, verifier] = await ethers.getSigners();
  const fromBlock = await ethers.provider.getBlockNumber();
  await ethers.provider.send("hardhat_mine", [`0x${blocksBeforeDeal.toString(16)}`]);
  const token = (await (await ethers.getContractFactory("MockUSDC")).deploy()) as Contract;
  const escrow = await deployEscrow();
  await token.waitForDeployment();
  await token.mint(await buyer.getAddress(), AMOUNT);
  await (token.connect(buyer) as Contract).approve(await escrow.getAddress(), AMOUNT);
  const deadline = BigInt(await time.latest()) + 10_000n;
  const receipt = await (await (escrow.connect(buyer) as Contract).openDeal(openParams({
    seller: await seller.getAddress(),
    verifier: await verifier.getAddress(),
    arbitrator: await arbiter.getAddress(),
    token: await token.getAddress(),
    amount: AMOUNT,
    bond: 0n,
    deadline
  }))).wait();
  return {
    deployment: {
      name,
      chainId: 31337,
      contract: await escrow.getAddress(),
      rpcUrl: "in-process",
      fromBlock,
      confirmations: 0
    },
    dealBlock: receipt!.blockNumber
  };
}

describe("data spine integration", function () {
  it("rejects invalid LOG_CHUNK_SIZE values and accepts a positive integer", async function () {
    const escrow = await deployEscrow();
    const chainTip = await ethers.provider.getBlockNumber();
    const deployment: DeploymentConfig = {
      name: "chunk-size-validation-test",
      chainId: 31337,
      contract: await escrow.getAddress(),
      rpcUrl: "in-process",
      fromBlock: chainTip,
      confirmations: 0
    };
    const db = openDatabase(":memory:");
    const previousChunkSize = process.env.LOG_CHUNK_SIZE;

    try {
      for (const value of ["0", "-2", "not-a-number"]) {
        process.env.LOG_CHUNK_SIZE = value;
        await expectRejection(
          indexDeployment(db, deployment, { provider: ethers.provider }),
          `LOG_CHUNK_SIZE must be a positive integer, got: ${Number(value)}`
        );
      }

      process.env.LOG_CHUNK_SIZE = "3";
      const result = await indexDeployment(db, deployment, { provider: ethers.provider });
      expect(result).to.deep.include({ fromBlock: chainTip, toBlock: chainTip, events: 0 });
    } finally {
      if (previousChunkSize === undefined) delete process.env.LOG_CHUNK_SIZE;
      else process.env.LOG_CHUNK_SIZE = previousChunkSize;
      db.close();
    }
  });

  it("buffers blocks by the configured confirmation depth", async function () {
    const escrow = await deployEscrow();
    await ethers.provider.send("hardhat_mine", ["0x5"]);
    const chainTip = await ethers.provider.getBlockNumber();
    const deployment: DeploymentConfig = {
      name: "confirmation-test",
      chainId: 31337,
      contract: await escrow.getAddress(),
      rpcUrl: "in-process",
      fromBlock: 0,
      confirmations: 3
    };
    const db = openDatabase(":memory:");

    const result = await indexDeployment(db, deployment, { provider: ethers.provider });

    expect(result.toBlock).to.equal(chainTip - deployment.confirmations);
    db.close();
  });

  // A wrong address matches no topic, so no logs are fetched and the run reports
  // zero events while looking healthy, "no contract here" reading the same as
  // "nothing has happened yet". The chainId check cannot catch it, because two
  // nodes of one network announce the same chain id. This is the guard that can.
  it("refuses an address with no contract code instead of indexing to zero events", async function () {
    const deployment: DeploymentConfig = {
      name: "codeless-address-test",
      chainId: 31337,
      contract: ethers.ZeroAddress,
      rpcUrl: "in-process",
      fromBlock: 0,
      confirmations: 0
    };
    const db = openDatabase(":memory:");

    await expectRejection(
      indexDeployment(db, deployment, { provider: ethers.provider }),
      "no contract code at"
    );
    // Nothing was written, and no checkpoint advanced.
    expect(db.prepare("SELECT COUNT(*) AS count FROM raw_events").get()).to.deep.equal({ count: 0 });
    expect(getSyncCheckpoint(db, deployment.name, getAddress(deployment.contract))).to.equal(null);
    db.close();
  });

  it("indexes normally once the address does carry code", async function () {
    const escrow = await deployEscrow();
    const deployment: DeploymentConfig = {
      name: "present-contract-test",
      chainId: 31337,
      contract: await escrow.getAddress(),
      rpcUrl: "in-process",
      fromBlock: 0,
      confirmations: 0
    };
    const db = openDatabase(":memory:");

    const result = await indexDeployment(db, deployment, { provider: ethers.provider });

    expect(result.events).to.equal(0);
    db.close();
  });

  it("records unknown token decimals without blocking healthy deals or the checkpoint", async function () {
    const [buyer, seller, arbiter, verifier] = await ethers.getSigners();
    const failingToken = (await (await ethers.getContractFactory("MockUSDC")).deploy()) as Contract;
    const healthyToken = (await (await ethers.getContractFactory("MockUSDC")).deploy()) as Contract;
    const escrow = await deployEscrow();
    await failingToken.waitForDeployment();
    await healthyToken.waitForDeployment();
    await failingToken.mint(await buyer.getAddress(), AMOUNT);
    await healthyToken.mint(await buyer.getAddress(), AMOUNT);
    await (failingToken.connect(buyer) as Contract).approve(await escrow.getAddress(), AMOUNT);
    await (healthyToken.connect(buyer) as Contract).approve(await escrow.getAddress(), AMOUNT);
    const deadline = BigInt(await time.latest()) + 10_000n;
    const openWith = async (token: Contract) => (escrow.connect(buyer) as Contract).openDeal(openParams({
      seller: await seller.getAddress(),
      verifier: await verifier.getAddress(),
      arbitrator: await arbiter.getAddress(),
      token: await token.getAddress(),
      amount: AMOUNT,
      bond: 0n,
      deadline
    }));
    const firstReceipt = await (await openWith(failingToken)).wait();
    await (await openWith(healthyToken)).wait();
    const deployment: DeploymentConfig = {
      name: "decimals-failure-test",
      chainId: 31337,
      contract: await escrow.getAddress(),
      rpcUrl: "in-process",
      fromBlock: firstReceipt!.blockNumber,
      confirmations: 0
    };
    const db = openDatabase(":memory:");
    const failingTokenAddress = getAddress(await failingToken.getAddress());
    const failingProvider = new Proxy(ethers.provider, {
      get(target, property) {
        if (property === "call") {
          return async (transaction: { to?: string }) => {
            if (transaction.to && getAddress(transaction.to) === failingTokenAddress) {
              throw new Error("decimals unavailable");
            }
            return target.call(transaction);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });

    const result = await indexDeployment(db, deployment, { provider: failingProvider });
    expect(getLastIndexedBlock(db, deployment.name, deployment.contract)).to.equal(result.toBlock);
    const rows = db.prepare("SELECT token, token_decimals FROM deals ORDER BY CAST(deal_id AS INTEGER)").all() as
      Array<{ token: string; token_decimals: number | null }>;
    expect(rows).to.deep.equal([
      { token: failingTokenAddress, token_decimals: null },
      { token: getAddress(await healthyToken.getAddress()), token_decimals: Number(await healthyToken.decimals()) }
    ]);
    db.close();
  });

  it("rolls back to the exact verified ancestor and deletes orphaned rows", async function () {
    const { deployment, dealBlock } = await deployRecentFundedDeal("recoverable-reorg-test");
    const db = openDatabase(":memory:");
    await indexDeployment(db, deployment, { provider: ethers.provider, chunkSize: 10 });
    const initialCheckpoint = getSyncCheckpoint(db, deployment.name, deployment.contract)!;
    const history = db.prepare(`
      SELECT block_number, block_hash FROM sync_checkpoint_history
      WHERE deployment = ? AND contract = ? ORDER BY block_number DESC
    `).all(deployment.name, getAddress(deployment.contract)) as Array<{ block_number: number; block_hash: string }>;
    const ancestor = history.find((row) => row.block_number < dealBlock)!;
    expect(ancestor).not.to.equal(undefined);
    expect(db.prepare("SELECT COUNT(*) AS count FROM deals WHERE block_number > ?").get(ancestor.block_number))
      .to.deep.equal({ count: 1 });

    const reorgProvider = providerWithReorg(ancestor.block_number, { dropLogs: true });
    const result = await indexDeployment(db, deployment, {
      provider: reorgProvider,
      chunkSize: 10
    });
    expect(result.fromBlock).to.equal(ancestor.block_number + 1);
    const currentTip = await reorgProvider.getBlock(initialCheckpoint.block);
    expect(getSyncCheckpoint(db, deployment.name, deployment.contract)).to.deep.equal({
      block: initialCheckpoint.block,
      hash: currentTip!.hash
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM deals WHERE deployment = ? AND contract = ?")
      .get(deployment.name, getAddress(deployment.contract))).to.deep.equal({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM raw_events WHERE deployment = ? AND contract = ?")
      .get(deployment.name, getAddress(deployment.contract))).to.deep.equal({ count: 0 });
    expect(db.prepare(`
      SELECT block_hash FROM sync_checkpoint_history
      WHERE deployment = ? AND contract = ? AND block_number = ?
    `).get(deployment.name, getAddress(deployment.contract), ancestor.block_number))
      .to.deep.equal({ block_hash: ancestor.block_hash });

    const unchanged = await indexDeployment(db, deployment, { provider: reorgProvider });
    expect(unchanged.events).to.equal(0);
    db.close();
  });

  it("detects a reorg between chunks before persisting more stale data", async function () {
    const { deployment, dealBlock } = await deployRecentFundedDeal("mid-run-reorg-test", 0);
    deployment.fromBlock = dealBlock;
    await ethers.provider.send("hardhat_mine", ["0x14"]);
    const db = openDatabase(":memory:");
    const reorgHash = `0x${"ee".repeat(32)}`;
    let getLogsCalls = 0;
    let reorged = false;
    const reorgProvider = new Proxy(ethers.provider, {
      get(target, property) {
        if (property === "getLogs") {
          return async (filter: Parameters<Provider["getLogs"]>[0]) => {
            getLogsCalls += 1;
            const staleView = !reorged;
            const logs = await target.getLogs(filter);
            if (getLogsCalls === 3) reorged = true;
            return staleView ? logs : [];
          };
        }
        if (property === "getBlock") {
          return async (blockTag: string | number) => {
            const block = await target.getBlock(blockTag);
            return block && reorged ? { ...block, hash: reorgHash } as typeof block : block;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as unknown as Provider;

    const result = await indexDeployment(db, deployment, { provider: reorgProvider, chunkSize: 5 });

    expect(getLogsCalls).to.be.greaterThan(4);
    expect(result.events).to.equal(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM deals WHERE deployment = ? AND contract = ?")
      .get(deployment.name, getAddress(deployment.contract))).to.deep.equal({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM raw_events WHERE deployment = ? AND contract = ?")
      .get(deployment.name, getAddress(deployment.contract))).to.deep.equal({ count: 0 });
    expect(getSyncCheckpoint(db, deployment.name, deployment.contract)?.hash).to.equal(reorgHash);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sync_checkpoint_history
      WHERE deployment = ? AND contract = ? AND block_hash != ?
    `).get(deployment.name, getAddress(deployment.contract), reorgHash)).to.deep.equal({ count: 0 });
    db.close();
  });

  it("retries a chunk when its boundary changes while reading logs", async function () {
    const { deployment, dealBlock } = await deployRecentFundedDeal("in-chunk-reorg-test", 0);
    await ethers.provider.send("hardhat_mine", ["0x1"]);
    const db = openDatabase(":memory:");
    const chunkSize = 5;
    const targetToBlock = Math.min(
      deployment.fromBlock + (Math.floor((dealBlock - deployment.fromBlock) / chunkSize) + 1) * chunkSize - 1,
      await ethers.provider.getBlockNumber()
    );
    const canonicalHash = `0x${"dd".repeat(32)}`;
    let targetBlockCalls = 0;
    let targetLogCalls = 0;
    const reorgProvider = new Proxy(ethers.provider, {
      get(target, property) {
        if (property === "getBlock") {
          return async (blockTag: string | number) => {
            const block = await target.getBlock(blockTag);
            if (!block || blockTag !== targetToBlock) return block;
            targetBlockCalls += 1;
            return {
              ...block,
              hash: targetBlockCalls === 1 ? block.hash : canonicalHash
            } as typeof block;
          };
        }
        if (property === "getLogs") {
          return async (filter: Parameters<Provider["getLogs"]>[0]) => {
            const logs = await target.getLogs(filter);
            if (!("toBlock" in filter) || filter.toBlock !== targetToBlock) return logs;
            targetLogCalls += 1;
            return targetLogCalls === 1 ? logs : [];
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as unknown as Provider;

    const result = await indexDeployment(db, deployment, { provider: reorgProvider, chunkSize });

    // Two chunk reads: the first sees the deal, the second (after the boundary moved) sees an
    // empty window, which getLogsRetryingEmpty asks for five times before accepting.
    expect(targetLogCalls).to.equal(6);
    expect(result.events).to.equal(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM deals WHERE deployment = ? AND contract = ?")
      .get(deployment.name, getAddress(deployment.contract))).to.deep.equal({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM raw_events WHERE deployment = ? AND contract = ?")
      .get(deployment.name, getAddress(deployment.contract))).to.deep.equal({ count: 0 });
    expect(getSyncCheckpoint(db, deployment.name, deployment.contract)).to.deep.equal({
      block: targetToBlock,
      hash: canonicalHash
    });
    db.close();
  });

  it("fully resets and rescans when a reorg exceeds the retained history", async function () {
    const { deployment } = await deployRecentFundedDeal("deep-reorg-test", 210);
    const db = openDatabase(":memory:");
    await indexDeployment(db, deployment, { provider: ethers.provider, chunkSize: 1 });
    const initialCheckpoint = getSyncCheckpoint(db, deployment.name, deployment.contract)!;
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sync_checkpoint_history WHERE deployment = ? AND contract = ?
    `).get(deployment.name, getAddress(deployment.contract))).to.deep.equal({ count: 200 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM deals WHERE deployment = ? AND contract = ?")
      .get(deployment.name, getAddress(deployment.contract)))
      .to.deep.equal({ count: 1 });

    const reorgProvider = providerWithReorg(deployment.fromBlock - 1, { dropLogs: true });
    const result = await indexDeployment(db, deployment, {
      provider: reorgProvider,
      chunkSize: 50
    });
    expect(result.fromBlock).to.equal(deployment.fromBlock);
    expect(db.prepare("SELECT COUNT(*) AS count FROM deals WHERE deployment = ? AND contract = ?")
      .get(deployment.name, getAddress(deployment.contract))).to.deep.equal({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM raw_events WHERE deployment = ? AND contract = ?")
      .get(deployment.name, getAddress(deployment.contract))).to.deep.equal({ count: 0 });
    expect(getSyncCheckpoint(db, deployment.name, deployment.contract)).to.deep.equal({
      block: initialCheckpoint.block,
      hash: `0x${"ff".repeat(32)}`
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sync_checkpoint_history
      WHERE deployment = ? AND contract = ? AND block_hash != ?
    `).get(deployment.name, getAddress(deployment.contract), `0x${"ff".repeat(32)}`))
      .to.deep.equal({ count: 0 });
    db.close();
  });

  it("fully resets instead of throwing when no ancestor exists at fromBlock", async function () {
    const escrow = await deployEscrow();
    const fromBlock = await ethers.provider.getBlockNumber();
    const deployment: DeploymentConfig = {
      name: "unrecoverable-reorg-test",
      chainId: 31337,
      contract: await escrow.getAddress(),
      rpcUrl: "in-process",
      fromBlock,
      confirmations: 0
    };
    const db = openDatabase(":memory:");
    await indexDeployment(db, deployment, { provider: ethers.provider });
    const checkpoint = getSyncCheckpoint(db, deployment.name, deployment.contract)!;

    const result = await indexDeployment(db, deployment, {
      provider: providerWithReorg(deployment.fromBlock - 1)
    });
    expect(result.fromBlock).to.equal(deployment.fromBlock);
    expect(getSyncCheckpoint(db, deployment.name, deployment.contract)).to.deep.equal({
      block: checkpoint.block,
      hash: `0x${"ff".repeat(32)}`
    });
    db.close();
  });

  // A version mismatch is not transient: the chain keeps serving the same logs, so
  // the backoff above would hide it behind a process that looks alive forever.
  // A misconfiguration is not a transient fault: the chain keeps serving the
  // same answer, so retrying only hides it behind a live-looking process.
  it("terminates watch mode on a missing contract rather than retrying it forever", async function () {
    const deployment: DeploymentConfig = {
      name: "watch-codeless-test",
      chainId: 31337,
      contract: ethers.ZeroAddress,
      rpcUrl: "http://127.0.0.1:1",
      fromBlock: 0,
      confirmations: 0
    };
    const db = openDatabase(":memory:");
    const originals = {
      getNetwork: JsonRpcProvider.prototype.getNetwork,
      getCode: JsonRpcProvider.prototype.getCode
    };
    JsonRpcProvider.prototype.getNetwork = async () => ({ chainId: 31337n }) as never;
    JsonRpcProvider.prototype.getCode = async () => "0x";

    try {
      await expectRejection(watchDeployment(db, deployment, 1_000), "no contract code at");
    } finally {
      Object.assign(JsonRpcProvider.prototype, originals);
      db.close();
    }
  });

  it("backs off failed watch polls exponentially and caps retries at 60 seconds", async function () {
    const deployment: DeploymentConfig = {
      name: "watch-backoff-test",
      chainId: 31337,
      contract: ethers.ZeroAddress,
      rpcUrl: "http://127.0.0.1:1",
      fromBlock: 0,
      confirmations: 0
    };
    const db = openDatabase(":memory:");
    const originalGetNetwork = JsonRpcProvider.prototype.getNetwork;
    const originalConsoleError = console.error;
    let attempts = 0;
    JsonRpcProvider.prototype.getNetwork = async function () {
      attempts += 1;
      throw new Error("RPC unavailable");
    };
    console.error = () => undefined;
    mock.timers.enable({ apis: ["setTimeout"] });
    const settle = async () => {
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    };

    try {
      void watchDeployment(db, deployment, 1_000);
      await settle();
      expect(attempts).to.equal(1);

      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
        const before = attempts;
        mock.timers.tick(delay - 1);
        await settle();
        expect(attempts).to.equal(before);
        mock.timers.tick(1);
        await settle();
        expect(attempts).to.equal(before + 1);
      }
    } finally {
      mock.timers.reset();
      JsonRpcProvider.prototype.getNetwork = originalGetNetwork;
      console.error = originalConsoleError;
      db.close();
    }
  });

  it("rejects invalid POLL_INTERVAL_MS values before polling", async function () {
    const deployment: DeploymentConfig = {
      name: "invalid-interval-test",
      chainId: 31337,
      contract: ethers.ZeroAddress,
      rpcUrl: "in-process",
      fromBlock: 0,
      confirmations: 0
    };
    const db = openDatabase(":memory:");
    const previousInterval = process.env.POLL_INTERVAL_MS;
    try {
      for (const value of ["0", "-1", "not-a-number"]) {
        process.env.POLL_INTERVAL_MS = value;
        await expectRejection(
          watchDeployment(db, deployment),
          `POLL_INTERVAL_MS must be a positive integer, got: ${Number(value)}`
        );
      }
    } finally {
      if (previousInterval === undefined) delete process.env.POLL_INTERVAL_MS;
      else process.env.POLL_INTERVAL_MS = previousInterval;
      db.close();
    }
  });

  it("rejects an invalid LOG_CHUNK_SIZE before polling", async function () {
    const deployment: DeploymentConfig = {
      name: "invalid-watch-chunk-size-test",
      chainId: 31337,
      contract: ethers.ZeroAddress,
      rpcUrl: "in-process",
      fromBlock: 0,
      confirmations: 0
    };
    const db = openDatabase(":memory:");
    const previousChunkSize = process.env.LOG_CHUNK_SIZE;
    process.env.LOG_CHUNK_SIZE = "0";

    try {
      await expectRejection(
        watchDeployment(db, deployment, 1_000),
        "LOG_CHUNK_SIZE must be a positive integer, got: 0"
      );
    } finally {
      if (previousChunkSize === undefined) delete process.env.LOG_CHUNK_SIZE;
      else process.env.LOG_CHUNK_SIZE = previousChunkSize;
      db.close();
    }
  });

  it("rejects non-positive CONFIRMATIONS from the environment", function () {
    const modulePath = require.resolve("../src/config");
    const cachedModule = require.cache[modulePath];
    const previousConfirmations = process.env.CONFIRMATIONS;
    process.env.CONFIRMATIONS = "0";
    delete require.cache[modulePath];

    try {
      expect(() => require("../src/config"))
        .to.throw("CONFIRMATIONS must be a positive integer, got: 0");
    } finally {
      if (previousConfirmations === undefined) delete process.env.CONFIRMATIONS;
      else process.env.CONFIRMATIONS = previousConfirmations;
      delete require.cache[modulePath];
      if (cachedModule) require.cache[modulePath] = cachedModule;
    }
  });

  it("uses port 18546 for the local deployment when LOCAL_RPC_URL is unset", function () {
    const modulePath = require.resolve("../src/config");
    const cachedModule = require.cache[modulePath];
    const previousRpcUrl = process.env.LOCAL_RPC_URL;
    delete process.env.LOCAL_RPC_URL;
    delete require.cache[modulePath];

    try {
      const { deployments } = require("../src/config") as typeof import("../src/config");
      expect(deployments.find((deployment) => deployment.name === "local")?.rpcUrl).to.equal(
        "http://127.0.0.1:18546"
      );
    } finally {
      if (previousRpcUrl === undefined) delete process.env.LOCAL_RPC_URL;
      else process.env.LOCAL_RPC_URL = previousRpcUrl;
      delete require.cache[modulePath];
      if (cachedModule) require.cache[modulePath] = cachedModule;
    }
  });

  it("repairs a Settled event a wide getLogs window answered without", async function () {
    forgetHoles();
    const signers = await ethers.getSigners();
    const token = (await (await ethers.getContractFactory("MockUSDC")).deploy()) as Contract;
    const escrow = await deployEscrow();
    await token.waitForDeployment();
    const connected = (contract: Contract, signer: Signer): Contract => contract.connect(signer) as Contract;
    const [buyer, seller, arbitrator, verifier] = signers;
    await token.mint(await buyer.getAddress(), AMOUNT);
    await connected(token, buyer).approve(await escrow.getAddress(), AMOUNT);
    await connected(escrow, buyer).openDeal(openParams({
      seller: await seller.getAddress(), verifier: await verifier.getAddress(), arbitrator: await arbitrator.getAddress(),
      token: await token.getAddress(), amount: AMOUNT, bond: 0n, deadline: BigInt(await time.latest()) + 10_000n
    }));
    const dealId = (await escrow.nextDealId()) - 1n;
    await connected(escrow, seller).submitDelivery(dealId, EVIDENCE);
    await connected(escrow, verifier).recordVerification(dealId, VERDICT_PASS, 0);
    await connected(escrow, buyer).settle(dealId, REASON_VERDICT_PASS, false);

    const settledTopic = id("Settled(uint256,bytes32,uint256,uint256)");
    let repairCalls = 0;
    // Chunk-pass filters carry one topic position; the RPC "loses" Settled from those.
    // Filters that name a dealId (the repair pass) answer in full.
    const lossy = new Proxy(ethers.provider, {
      get(target, property) {
        if (property === "getLogs") {
          return async (filter: Parameters<Provider["getLogs"]>[0]) => {
            const logs = await target.getLogs(filter);
            const topics = (filter as { topics?: unknown[] }).topics ?? [];
            if (topics.length > 1) { repairCalls += 1; return logs; }
            return logs.filter((log) => log.topics[0] !== settledTopic);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as unknown as Provider;

    const deployment: DeploymentConfig = {
      name: "hardhat-repair", chainId: 31337, contract: await escrow.getAddress(), rpcUrl: "in-process", fromBlock: 0, confirmations: 0
    };
    const db = openDatabase(":memory:");
    const result = await indexDeployment(db, deployment, { provider: lossy, chunkSize: 50 });
    expect(repairCalls).to.equal(1);
    expect(result.repaired).to.equal(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM raw_events WHERE event_name = 'Settled'").get()).to.deep.equal({ n: 1 });
    expect(listSettledDeals(db).map((entry) => entry.deal.deal_id)).to.deep.equal([String(dealId)]);
    // An open deal is re-asked once, then left alone for the cooldown.
    expect((await indexDeployment(db, deployment, { provider: lossy })).repaired).to.equal(0);
    expect(repairCalls).to.equal(1);
  });

  it("indexes four settlement paths end-to-end and resolves each outcome", async function () {
    const signers = await ethers.getSigners();
    const token = (await (await ethers.getContractFactory("MockUSDC")).deploy()) as Contract;
    const escrow = await deployEscrow();
    await token.waitForDeployment();

    const connected = (contract: Contract, signer: Signer): Contract => contract.connect(signer) as Contract;

    async function open(buyerIndex: number, sellerIndex: number, arbiterIndex: number, verifierIndex: number, bond: bigint, deadline: bigint) {
      const buyer = signers[buyerIndex];
      const seller = signers[sellerIndex];
      await token.mint(await buyer.getAddress(), AMOUNT);
      await connected(token, buyer).approve(await escrow.getAddress(), AMOUNT);
      if (bond > 0n) {
        await token.mint(await seller.getAddress(), bond);
        await connected(token, seller).approve(await escrow.getAddress(), bond);
      }
      await connected(escrow, buyer).openDeal(openParams({
        seller: await seller.getAddress(),
        verifier: await signers[verifierIndex].getAddress(),
        arbitrator: await signers[arbiterIndex].getAddress(),
        token: await token.getAddress(),
        amount: AMOUNT,
        bond,
        deadline
      }));
      const id = (await escrow.nextDealId()) - 1n;
      if (bond > 0n) await connected(escrow, seller).postBond(id);
      return id;
    }

    const longDeadline = BigInt(await time.latest()) + 10_000n;
    const verifierRelease = await open(0, 1, 2, 3, BOND, longDeadline);
    // 1. The optimistic path: verifier passes, nobody challenges, it executes.
    await connected(escrow, signers[1]).submitDelivery(verifierRelease, EVIDENCE);
    await connected(escrow, signers[3]).recordVerification(verifierRelease, VERDICT_PASS, 0);
    await connected(escrow, signers[0]).settle(verifierRelease, REASON_VERDICT_PASS, false);

    // 2. Challenged, and the arbitrator rules for the seller. V04 replaced V02's
    //    2-of-3 vote with a single ruling, so this is one call rather than two.
    const disputeRelease = await open(0, 1, 4, 5, 0n, longDeadline);
    await connected(escrow, signers[1]).submitDelivery(disputeRelease, EVIDENCE);
    await connected(escrow, signers[5]).recordVerification(disputeRelease, VERDICT_FAIL, 0);
    await connected(escrow, signers[1]).challenge(disputeRelease, 0n, 0);
    await connected(escrow, signers[4]).settle(disputeRelease, REASON_RULING_RELEASE, false);

    // 3. Challenged, arbitrator rules refund. The one V04 path that slashes.
    const disputeSlash = await open(10, 11, 12, 13, BOND, longDeadline);
    await connected(escrow, signers[11]).submitDelivery(disputeSlash, EVIDENCE);
    await connected(escrow, signers[13]).recordVerification(disputeSlash, VERDICT_FAIL, 0);
    await connected(escrow, signers[10]).challenge(disputeSlash, 0n, 0);
    await connected(escrow, signers[12]).settle(disputeSlash, REASON_RULING_REFUND, true);

    // 4. The deadline path, with no verdict recorded at all.
    const timeoutDeadline = BigInt(await time.latest()) + 10n;
    const timeoutRefund = await open(6, 7, 8, 9, BOND, timeoutDeadline);
    await time.increaseTo(timeoutDeadline);
    await escrow.claimTimeout(timeoutRefund);

    const deployment: DeploymentConfig = {
      name: "hardhat-test",
      chainId: 31337,
      contract: await escrow.getAddress(),
      rpcUrl: "in-process",
      fromBlock: 0,
      confirmations: 0
    };
    const db = openDatabase(":memory:");
    const result = await indexDeployment(db, deployment, { provider: ethers.provider, chunkSize: 3 });
    expect(result.events).to.be.greaterThan(0);
    expect((await indexDeployment(db, deployment, { provider: ethers.provider })).events).to.equal(0);

    const settled = listSettledDeals(db);
    expect(settled.map((entry) => entry.deal.deal_id)).to.deep.equal(
      [verifierRelease, disputeRelease, disputeSlash, timeoutRefund].map(String)
    );
    expect(settled.map((entry) => entry.resolution)).to.deep.equal(["release", "release", "refund_and_slash", "refund"]);
    for (const entry of settled) {
      expect(entry.settled_at).to.be.at.least(entry.deal.funded_at);
      const resolved = resolveDeal(db, deployment.chainId, deployment.contract, entry.deal.deal_id);
      expect(resolved?.resolution).to.equal(entry.resolution);
    }
    expect(resolveDeal(db, deployment.chainId, deployment.contract, "999")).to.equal(null);
    db.close();
  });
});
