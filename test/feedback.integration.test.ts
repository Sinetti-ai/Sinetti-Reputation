import { expect } from "chai";
import { ethers } from "hardhat";
import request from "supertest";
import { Provider, Wallet, encodeBytes32String, getAddress, keccak256, toUtf8Bytes } from "ethers";
import { createApp } from "../src/api";
import { StoredDeal, openDatabase } from "../src/db";
import { Fetcher, agentFeedbackCard, checkFeedbackFiles, indexRegistryFeedback, listVerifiedAgents, recheckFeedback } from "../src/feedback";
import { forgetHoles } from "../src/logs";
import { KNOWN_REGISTRIES, RegistryConfig } from "../src/registries";

const ESCROW = getAddress("0x0000000000000000000000000000000000000E5C");
const TOKEN = "0x0000000000000000000000000000000000000001";
const ZERO_HASH = `0x${"00".repeat(32)}`;

interface MockIdentity {
  register(agentURI: string): Promise<{ wait(): Promise<unknown> }>;
  setAgentWallet(agentId: string, wallet: string): Promise<{ wait(): Promise<unknown> }>;
}
interface MockReputation {
  giveFeedback(agentId: string, value: number, decimals: number, tag1: string, tag2: string, endpoint: string, uri: string, hash: string): Promise<{ wait(): Promise<unknown> }>;
  revokeFeedback(agentId: string, index: number): Promise<{ wait(): Promise<unknown> }>;
}

describe("ERC-8004 feedback reader", function () {
  let db: ReturnType<typeof openDatabase>;
  let registry: RegistryConfig;
  let reputation: Awaited<ReturnType<typeof deploy>>["reputation"];
  let identity: Awaited<ReturnType<typeof deploy>>["identity"];
  let agentOwner: Wallet;
  let buyer: Wallet;
  let stranger: Wallet;
  const files = new Map<string, string>();
  const fetcher: Fetcher = async (url) => {
    const body = files.get(url);
    return body === undefined ? { status: 404, body: new Uint8Array() } : { status: 200, body: new TextEncoder().encode(body) };
  };

  async function deploy() {
    const identityContract = await (await ethers.getContractFactory("MockIdentityRegistry")).deploy();
    await identityContract.waitForDeployment();
    const reputationContract = await (await ethers.getContractFactory("MockReputationRegistry")).deploy(await identityContract.getAddress());
    await reputationContract.waitForDeployment();
    return { identity: identityContract, reputation: reputationContract };
  }

  function insertSettledDeal(dealId: string, dealBuyer: string, dealSeller: string, reason = "accepted"): void {
    const deal: StoredDeal = {
      deployment: "escrow-test", chain_id: 31337, contract: ESCROW, deal_id: dealId, block_number: 1,
      buyer: dealBuyer, seller: dealSeller, arbiter: stranger.address, verifier: stranger.address, token: TOKEN,
      token_decimals: 2, amount: "1000", bond: "0", criteria_hash: ZERO_HASH, deadline: 2_000_000_000, funded_at: 1_700_000_000
    };
    db.prepare(`INSERT INTO deals (deployment, chain_id, contract, deal_id, block_number, buyer, seller, arbiter, verifier, token,
      token_decimals, amount, bond, criteria_hash, deadline, funded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(deal.deployment, deal.chain_id, deal.contract, deal.deal_id, deal.block_number, deal.buyer, deal.seller, deal.arbiter,
        deal.verifier, deal.token, deal.token_decimals, deal.amount, deal.bond, deal.criteria_hash, deal.deadline, deal.funded_at);
    db.prepare(`INSERT INTO raw_events (deployment, chain_id, contract, tx_hash, log_index, block_number, block_timestamp, deal_id, event_name, args_json)
      VALUES (?, ?, ?, ?, 0, 2, 1700000100, ?, 'Settled', ?)`)
      .run(deal.deployment, deal.chain_id, deal.contract, `0x${dealId.padStart(64, "0")}`, dealId, JSON.stringify({ reason: encodeBytes32String(reason) }));
  }

  function fileFor(dealId: string, extra: Record<string, unknown> = {}): { uri: string; hash: string } {
    const uri = `https://rater.example/feedback-${dealId}-${files.size}.json`;
    const body = JSON.stringify({ settlement: { chainId: 31337, contract: ESCROW, dealId }, ...extra });
    files.set(uri, body);
    return { uri, hash: keccak256(toUtf8Bytes(body)) };
  }

  async function rate(from: Wallet, agentId: string, value: number, uri: string, hash: string): Promise<void> {
    const contract = reputation.connect(from) as unknown as MockReputation;
    await (await contract.giveFeedback(agentId, value, 0, "release", "", "", uri, hash)).wait();
  }

  async function readAll(): Promise<void> {
    await indexRegistryFeedback(db, registry, { provider: ethers.provider });
    await checkFeedbackFiles(db, registry, { provider: ethers.provider, fetcher });
  }

  beforeEach(async function () {
    forgetHoles();
    db = openDatabase(":memory:");
    files.clear();
    ({ identity, reputation } = await deploy());
    const signers = await ethers.getSigners();
    [agentOwner, buyer, stranger] = signers.slice(1, 4) as unknown as Wallet[];
    await (await (identity.connect(agentOwner) as unknown as MockIdentity).register("https://agent.example/card.json")).wait();
    registry = {
      name: "hardhat", chainId: 31337, fromBlock: 0, identityFromBlock: 0, firstAgentId: 1, confirmations: 0, rpcUrl: "unused",
      reputationRegistry: getAddress(await reputation.getAddress()),
      identityRegistry: getAddress(await identity.getAddress())
    };
  });

  afterEach(function () {
    db.close();
  });

  it("verifies a rating whose file names a settled deal between rater and agent", async function () {
    insertSettledDeal("1", buyer.address, agentOwner.address);
    const { uri, hash } = fileFor("1");
    await rate(buyer, "1", 100, uri, hash);
    await readAll();

    const card = agentFeedbackCard(db, registry, "1")!;
    expect(card.feedback).to.deep.equal({ total: 1, revoked: 0, unchecked: 0, verified: 1, duplicates: 0 });
    expect(card.verified_score).to.equal(100);
    expect(card.verified_clients).to.deep.equal([getAddress(buyer.address)]);
    expect(card.entries[0].evidence).to.include({ dealId: "1", clientRole: "buyer", agentAddress: getAddress(agentOwner.address), resolution: "release" });
    expect(card.registry).to.equal(`eip155:31337:${registry.reputationRegistry}`);
  });

  it("counts but never scores ratings with no proof, a bad hash, or a deal the rater was not part of", async function () {
    insertSettledDeal("1", buyer.address, agentOwner.address);
    // A stranger points at the buyer's deal.
    const stolen = fileFor("1");
    await rate(stranger, "1", 100, stolen.uri, stolen.hash);
    // The buyer points at a file that was swapped after pinning.
    const swapped = fileFor("1");
    files.set(swapped.uri, files.get(swapped.uri)! + " ");
    await rate(buyer, "1", 100, swapped.uri, swapped.hash);
    // A rating with no file at all.
    await rate(stranger, "1", 100, "", ZERO_HASH);
    // A rating pointing at a private host.
    await rate(stranger, "1", 100, "https://127.0.0.1/f.json", ZERO_HASH);
    await readAll();

    const card = agentFeedbackCard(db, registry, "1")!;
    expect(card.feedback).to.include({ total: 4, verified: 0 });
    expect(card.verified_score).to.equal(null);
    expect(card.entries).to.deep.equal([]);
    const statuses = db.prepare("SELECT file_status FROM erc8004_feedback ORDER BY block_number, log_index").all() as Array<{ file_status: string }>;
    expect(statuses.map((row) => row.file_status)).to.deep.equal(["ok", "hash_mismatch", "no_uri", "private_host"]);
    expect(listVerifiedAgents(db, registry).agents).to.deep.equal([]);
  });

  it("uses the agent's declared wallet as well as its owner", async function () {
    const wallet = Wallet.createRandom().address;
    await (await (identity.connect(agentOwner) as unknown as MockIdentity).setAgentWallet("1", wallet)).wait();
    insertSettledDeal("1", buyer.address, wallet);
    const { uri, hash } = fileFor("1");
    await rate(buyer, "1", 100, uri, hash);
    await readAll();
    expect(agentFeedbackCard(db, registry, "1")!.feedback.verified).to.equal(1);
  });

  it("drops a revoked rating from the verified set and averages the rest", async function () {
    insertSettledDeal("1", buyer.address, agentOwner.address);
    insertSettledDeal("2", buyer.address, agentOwner.address, "timeout");
    const first = fileFor("1");
    const second = fileFor("2");
    await rate(buyer, "1", 100, first.uri, first.hash);
    await rate(buyer, "1", 0, second.uri, second.hash);
    await readAll();
    expect(agentFeedbackCard(db, registry, "1")!.verified_score).to.equal(50);

    await (await (reputation.connect(buyer) as unknown as MockReputation).revokeFeedback("1", 2)).wait();
    await readAll();
    const card = agentFeedbackCard(db, registry, "1")!;
    expect(card.feedback).to.deep.equal({ total: 2, revoked: 1, unchecked: 0, verified: 1, duplicates: 0 });
    expect(card.verified_score).to.equal(100);
  });

  it("counts one settled deal once per rater however many times it is cited", async function () {
    insertSettledDeal("1", buyer.address, agentOwner.address);
    for (let i = 0; i < 3; i += 1) {
      const { uri, hash } = fileFor("1");
      await rate(buyer, "1", 100, uri, hash);
    }
    await readAll();
    const card = agentFeedbackCard(db, registry, "1")!;
    expect(card.feedback).to.deep.equal({ total: 3, revoked: 0, unchecked: 0, verified: 1, duplicates: 2 });
    expect(card.entries).to.have.lengthOf(1);
    expect(listVerifiedAgents(db, registry).agents).to.deep.equal([{ agent_id: "1", name: null, verified: 1, total: 3 }]);
  });

  it("never verifies the agent rating itself from its declared wallet", async function () {
    // The registry blocks the owner from rating its own agent. It does not
    // block the agent's declared wallet, so the reader has to.
    const wallet = stranger;
    await (await (identity.connect(agentOwner) as unknown as MockIdentity).setAgentWallet("1", wallet.address)).wait();
    insertSettledDeal("1", wallet.address, agentOwner.address);
    const { uri, hash } = fileFor("1");
    await rate(wallet, "1", 100, uri, hash);
    await readAll();
    expect(agentFeedbackCard(db, registry, "1")!.feedback.verified).to.equal(0);
  });

  it("checks in bounded batches, retries unreachable files later, and re-checks on demand", async function () {
    insertSettledDeal("1", buyer.address, agentOwner.address);
    const { uri, hash } = fileFor("1");
    const body = files.get(uri)!;
    files.delete(uri);
    await rate(buyer, "1", 100, uri, hash);
    await rate(buyer, "1", 100, "", ZERO_HASH);
    await indexRegistryFeedback(db, registry, { provider: ethers.provider });
    let clock = 1_000;
    const now = () => clock;
    expect(await checkFeedbackFiles(db, registry, { provider: ethers.provider, fetcher, limit: 1, now })).to.equal(1);
    expect(agentFeedbackCard(db, registry, "1")!.feedback.unchecked).to.equal(1);
    expect(await checkFeedbackFiles(db, registry, { provider: ethers.provider, fetcher, limit: 1, now })).to.equal(1);
    expect(agentFeedbackCard(db, registry, "1")!.feedback.verified).to.equal(0);

    // The host comes back. Nothing is retried until the retry window passes.
    files.set(uri, body);
    expect(await checkFeedbackFiles(db, registry, { provider: ethers.provider, fetcher, now })).to.equal(0);
    clock += 86_401;
    expect(await checkFeedbackFiles(db, registry, { provider: ethers.provider, fetcher, now })).to.equal(1);
    expect(agentFeedbackCard(db, registry, "1")!.feedback.verified).to.equal(1);

    // A final status is final until an operator asks for a re-check.
    expect(recheckFeedback(db, registry, "1")).to.equal(2);
    expect(agentFeedbackCard(db, registry, "1")!.feedback.unchecked).to.equal(2);
    // The old verdict goes with the status: nothing reads as verified on stale evidence.
    expect(agentFeedbackCard(db, registry, "1")!.feedback.verified).to.equal(0);
    expect(await checkFeedbackFiles(db, registry, { provider: ethers.provider, fetcher, now })).to.equal(2);
  });

  it("resumes from its checkpoint and does not re-fetch checked files", async function () {
    insertSettledDeal("1", buyer.address, agentOwner.address);
    const { uri, hash } = fileFor("1");
    await rate(buyer, "1", 100, uri, hash);
    await readAll();
    files.clear();
    const again = await indexRegistryFeedback(db, registry, { provider: ethers.provider });
    expect(again.events).to.equal(0);
    expect(await checkFeedbackFiles(db, registry, { provider: ethers.provider, fetcher })).to.equal(0);
    expect(agentFeedbackCard(db, registry, "1")!.feedback.verified).to.equal(1);
  });

  it("refuses a registry address with no code rather than indexing nothing", async function () {
    const empty = { ...registry, reputationRegistry: Wallet.createRandom().address };
    let message = "";
    await indexRegistryFeedback(db, empty, { provider: ethers.provider }).catch((error: Error) => { message = error.message; });
    expect(message).to.match(/No contract code/);
  });

  describe("API", function () {
    it("serves registry cards and the derived agent list", async function () {
      // The API resolves registries by name, so the test registry is exposed
      // under a known name for the duration of the test.
      const saved = KNOWN_REGISTRIES.hardhat;
      KNOWN_REGISTRIES.hardhat = { ...registry };
      try {
        insertSettledDeal("1", buyer.address, agentOwner.address);
        const { uri, hash } = fileFor("1");
        await rate(buyer, "1", 100, uri, hash);
        await readAll();
        const app = createApp(db);

        const list = await request(app).get("/registries").expect(200);
        expect(list.body.registries.map((entry: { name: string }) => entry.name)).to.include("hardhat");
        const hardhat = list.body.registries.find((entry: { name: string }) => entry.name === "hardhat");
        expect(hardhat.missing).to.deep.equal({ agents: 0, feedback: 0 });

        const agents = await request(app).get("/registries/hardhat/agents").expect(200);
        expect(agents.body.page).to.equal(1);
        expect(agents.body.pages).to.equal(1);
        expect(agents.body.agents).to.deep.equal([{ agent_id: "1", name: null, verified: 1, total: 1 }]);

        const card = await request(app).get("/registries/hardhat/agents/1").expect(200);
        expect(card.body.verified_score).to.equal(100);
        expect(card.body.entries[0].evidence.dealId).to.equal("1");

        await request(app).get("/registries/hardhat/agents/2").expect(404);
        await request(app).get("/registries/hardhat/agents/abc").expect(400);
        await request(app).get("/registries/nowhere/agents/1").expect(404);
        // Names inherited from Object.prototype are not registries.
        for (const name of ["constructor", "toString", "valueOf", "__proto__"]) {
          await request(app).get(`/registries/${name}/agents`).expect(404);
          await request(app).get(`/registries/${name}/agents/1`).expect(404);
          await request(app).get(`/r/${name}`).expect(404);
          await request(app).get(`/r/${name}/1`).expect(404);
        }
      } finally {
        if (saved) KNOWN_REGISTRIES.hardhat = saved; else delete KNOWN_REGISTRIES.hardhat;
      }
    });
  });

  it("repairs a feedback-index hole a wide getLogs window answered without", async function () {
    insertSettledDeal("1", buyer.address, agentOwner.address);
    for (let i = 0; i < 3; i += 1) {
      const { uri, hash } = fileFor("1");
      await rate(buyer, "1", 100, uri, hash);
    }
    let repairCalls = 0;
    const lossy = new Proxy(ethers.provider, {
      get(target, property) {
        if (property === "getLogs") {
          return async (filter: Parameters<Provider["getLogs"]>[0]) => {
            const logs = await target.getLogs(filter);
            const topics = (filter as { topics?: unknown[] }).topics ?? [];
            if (topics.length > 1) {
              repairCalls += 1;
              return logs;
            }
            // feedbackIndex is unindexed: drop the second NewFeedback by position.
            let seen = 0;
            return logs.filter(() => (seen += 1) !== 2);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as unknown as Provider;

    const result = await indexRegistryFeedback(db, registry, { provider: lossy });
    expect(repairCalls).to.equal(1);
    expect(result.repaired).to.equal(1);
    expect(result.missing).to.equal(0);
    const indexes = db.prepare("SELECT feedback_index FROM erc8004_feedback ORDER BY feedback_index").all() as Array<{ feedback_index: number }>;
    expect(indexes.map((row) => row.feedback_index)).to.deep.equal([1, 2, 3]);
  });
});
