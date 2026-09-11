import { expect } from "chai";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "hardhat";
import { Wallet, encodeBytes32String, getAddress } from "ethers";
import { StoredDeal, openDatabase } from "../src/db";
import {
  IDENTITY_REGISTRY_ABI, OUTCOME_VALUE, REPUTATION_REGISTRY_ABI, RegistryConfig,
  VALUE_DECIMALS, checkAgentId, feedbackDocumentHash, listPendingPublications, parseAgentIds,
  planPublication, publish
} from "../src/publisher";
import { REPUTATION_REGISTRY_EVENTS_ABI } from "../src/registries";
import { settlementFeedbackDocument, settlementFeedbackUri } from "../src/standards";
import request from "supertest";
import { createApp } from "../src/api";
import { keccak256 } from "ethers";

const BUYER = "0x00000000000000000000000000000000000000B2";
const OTHER = "0x00000000000000000000000000000000000000C3";
const TOKEN = "0x0000000000000000000000000000000000000001";

type Outcome = "release" | "refund" | "refund_and_slash";

/**
 * Explicit rather than chai-as-promised: the project does not wire that plugin
 * into its type setup, and every refusal here is a safety guard whose message
 * is the thing worth asserting.
 */
async function rejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).to.match(pattern);
    return;
  }
  expect.fail(`expected rejection matching ${pattern}`);
}

function insertDeal(
  db: ReturnType<typeof openDatabase>,
  dealId: string,
  seller: string,
  outcome: Outcome
): void {
  const deal: StoredDeal = {
    deployment: "erc8004-test",
    chain_id: 31337,
    contract: TOKEN,
    deal_id: dealId,
    block_number: Number(dealId),
    buyer: BUYER,
    seller,
    arbiter: OTHER,
    verifier: OTHER,
    token: TOKEN,
    token_decimals: 2,
    amount: "1000",
    bond: "500",
    criteria_hash: `0x${"00".repeat(32)}`,
    deadline: 2_000_000_000,
    funded_at: 1_700_000_000 + Number(dealId)
  };
  db.prepare(`
    INSERT INTO deals (
      deployment, chain_id, contract, deal_id, block_number, buyer, seller, arbiter, verifier, token,
      token_decimals, amount, bond, criteria_hash, deadline, funded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    deal.deployment, deal.chain_id, deal.contract, deal.deal_id, deal.block_number,
    deal.buyer, deal.seller, deal.arbiter, deal.verifier, deal.token, deal.token_decimals,
    deal.amount, deal.bond, deal.criteria_hash, deal.deadline, deal.funded_at
  );

  // V04 vocabulary: one `Settled` log carries the reason, and the reason alone
  // decides release from refund. A slash is not inferable from the reason, since a
  // deal that never posted a bond settles `ruling_refund` too, so it is
  // anchored on a separate BondSlashed log, which is what the settlement reader reads.
  const events: Array<{ name: string; args: Record<string, string> }> = outcome === "release"
    ? [{ name: "Settled", args: { reason: encodeBytes32String("accepted") } }]
    : outcome === "refund"
      ? [
        // A timeout refund never slashes: nobody was found at fault.
        { name: "Settled", args: { reason: encodeBytes32String("timeout") } }
      ]
      : [
        // ruling_refund is the only V04 path that can slash, and it does so
        // only when a bond was actually in custody.
        { name: "BondSlashed", args: {} },
        { name: "Settled", args: { reason: encodeBytes32String("ruling_refund") } }
      ];

  events.forEach((event, logIndex) => {
    db.prepare(`
      INSERT INTO raw_events (
        deployment, chain_id, contract, tx_hash, log_index, block_number,
        block_timestamp, deal_id, event_name, args_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deal.deployment, deal.chain_id, deal.contract, `0x${dealId.padStart(64, "0")}`, logIndex,
      deal.block_number, deal.funded_at, dealId, event.name, JSON.stringify(event.args)
    );
  });
}

/** `connect()` widens to BaseContract; the mock's own methods are what we want. */
interface MockIdentity {
  register(agentURI: string): Promise<{ wait(): Promise<unknown> }>;
  setAgentWallet(agentId: string, wallet: string): Promise<{ wait(): Promise<unknown> }>;
  approve(to: string, agentId: string): Promise<{ wait(): Promise<unknown> }>;
}
function asRegistry(contract: unknown): MockIdentity {
  return contract as MockIdentity;
}

describe("ERC-8004 reputation publishing", function () {
  let db: ReturnType<typeof openDatabase>;
  let registry: RegistryConfig;
  let reputation: Awaited<ReturnType<typeof deployRegistries>>["reputation"];
  let identity: Awaited<ReturnType<typeof deployRegistries>>["identity"];
  let publisher: Wallet;
  let seller: Wallet;
  let agentId: string;

  async function deployRegistries() {
    const identityFactory = await ethers.getContractFactory("MockIdentityRegistry");
    const identityContract = await identityFactory.deploy();
    await identityContract.waitForDeployment();
    const reputationFactory = await ethers.getContractFactory("MockReputationRegistry");
    const reputationContract = await reputationFactory.deploy(await identityContract.getAddress());
    await reputationContract.waitForDeployment();
    return { identity: identityContract, reputation: reputationContract };
  }

  beforeEach(async function () {
    db = openDatabase(":memory:");
    const deployed = await deployRegistries();
    identity = deployed.identity;
    reputation = deployed.reputation;

    // Two distinct funded signers rather than a hardcoded key: the seller registers
    // and owns its own agent, because ERC-8004 forbids the agent's owner from
    // giving it feedback and the publisher is the one giving it.
    const signers = await ethers.getSigners();
    publisher = signers[0] as unknown as Wallet;
    seller = signers[1] as unknown as Wallet;

    const tx = await asRegistry(identity.connect(seller)).register("https://example.com/agent.json");
    await tx.wait();
    agentId = "1";
    await (await asRegistry(identity.connect(seller)).setAgentWallet(agentId, seller.address)).wait();

    registry = {
      name: "hardhat",
      fromBlock: 0,
      identityFromBlock: 0, firstAgentId: 1,
      confirmations: 0,
      chainId: 31337,
      reputationRegistry: getAddress(await reputation.getAddress()),
      identityRegistry: getAddress(await identity.getAddress()),
      rpcUrl: "unused-in-test"
    };
  });

  afterEach(function () {
    db.close();
  });

  // The constraint the whole module is built around. A read function reaching
  // this ABI is how sybil-poisoned scores would start flowing into Sinetti.
  describe("write-only", function () {
    it("exposes exactly one reputation-registry function, and it is a write", function () {
      expect(REPUTATION_REGISTRY_ABI).to.have.lengthOf(1);
      expect(REPUTATION_REGISTRY_ABI[0]).to.contain("function giveFeedback");
      expect(REPUTATION_REGISTRY_ABI[0]).to.not.contain("view");
    });

    it("carries no reputation read function under any name", function () {
      const surface = REPUTATION_REGISTRY_ABI.join(" ");
      for (const forbidden of ["getSummary", "readFeedback", "readAllFeedback", "getClients", "getLastIndex", "getResponseCount"]) {
        expect(surface, `ABI must not expose ${forbidden}`).to.not.contain(forbidden);
      }
    });

    it("reads the registry through events only, never through a function", function () {
      expect(REPUTATION_REGISTRY_EVENTS_ABI.every((entry) => entry.startsWith("event "))).to.equal(true);
      const surface = REPUTATION_REGISTRY_EVENTS_ABI.join(" ");
      for (const forbidden of ["getSummary", "readFeedback", "readAllFeedback", "getClients", "function"]) {
        expect(surface, `events ABI must not expose ${forbidden}`).to.not.contain(forbidden);
      }
    });

    // Identity reads are permitted and separate: they answer who an agentId is,
    // never how good anyone is.
    it("limits identity reads to binding checks", function () {
      const surface = IDENTITY_REGISTRY_ABI.join(" ");
      expect(surface).to.contain("getAgentWallet");
      expect(surface).to.contain("ownerOf");
      expect(surface).to.not.contain("Feedback");
    });
  });

  describe("planning", function () {
    it("maps each settled outcome to its value and tag", function () {
      insertDeal(db, "1", seller.address, "release");
      insertDeal(db, "2", seller.address, "refund");
      insertDeal(db, "3", seller.address, "refund_and_slash");

      const plans = planPublication(db, registry, parseAgentIds(`${seller.address}=${agentId}`), publisher.address);
      expect(plans.map((plan) => [plan.tag1, plan.value])).to.deep.equal([
        ["release", 100], ["refund", 0], ["refund_and_slash", 0]
      ]);
      expect(new Set(plans.map((plan) => plan.valueDecimals))).to.deep.equal(new Set([VALUE_DECIMALS]));
    });

    it("uses the seller as the subject and a per-deal settlement document as the feedbackURI", function () {
      insertDeal(db, "1", seller.address, "release");
      const [plan] = planPublication(db, registry, parseAgentIds(`${seller.address}=${agentId}`), publisher.address);
      expect(plan.subject).to.equal(getAddress(seller.address));
      expect(plan.feedbackURI).to.equal(
        `https://rep.sinetti.ai/feedback/eip155:31337:${registry.reputationRegistry}/${agentId}/${getAddress(publisher.address)}`
        + `/eip155:31337:${getAddress(TOKEN)}/1`
      );
      expect(plan.tag2).to.equal(`eip155:31337:${getAddress(TOKEN)}`);
    });

    // The hash is what lets a reader refuse a swapped file. It must be the
    // keccak of exactly the bytes the document route serves.
    it("pins feedbackHash to the settlement document the URI serves", function () {
      insertDeal(db, "1", seller.address, "release");
      const [plan] = planPublication(db, registry, parseAgentIds(`${seller.address}=${agentId}`), publisher.address);
      const reference = {
        registryChainId: 31337, registry: registry.reputationRegistry, agentId, client: publisher.address,
        chainId: 31337, contract: TOKEN, dealId: "1"
      };
      const document = settlementFeedbackDocument(db, reference)!;
      expect(plan.feedbackURI).to.equal(settlementFeedbackUri(reference));
      expect(plan.feedbackHash).to.equal(feedbackDocumentHash(document));
      expect(plan.feedbackHash).to.match(/^0x[0-9a-f]{64}$/).and.not.equal(`0x${"00".repeat(32)}`);
      expect(document.settlement).to.deep.equal({ chainId: 31337, contract: getAddress(TOKEN), dealId: "1" });
      expect(document.clientAddress).to.equal(getAddress(publisher.address));
      expect(document.value).to.equal(100);
      expect(plan.endpoint).to.equal("");
    });

    it("serves the pinned document byte for byte over HTTP", async function () {
      insertDeal(db, "1", seller.address, "release");
      const [plan] = planPublication(db, registry, parseAgentIds(`${seller.address}=${agentId}`), publisher.address);
      const path = plan.feedbackURI.replace("https://rep.sinetti.ai", "");
      const response = await request(createApp(db)).get(path).buffer(true).parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      }).expect(200);
      expect(response.headers["content-type"]).to.include("application/json");
      expect(keccak256(new Uint8Array(response.body as Buffer))).to.equal(plan.feedbackHash);
      await request(createApp(db)).get(path.replace(/\/1$/, "/999")).expect(404);
      await request(createApp(db)).get(path.replace(getAddress(publisher.address), "nope")).expect(400);
    });

    it("skips sellers with no supplied agentId rather than guessing one", function () {
      insertDeal(db, "1", seller.address, "release");
      expect(planPublication(db, registry, new Map(), publisher.address)).to.deep.equal([]);
      // The same deal, with an agentId supplied, must plan. Otherwise the
      // empty result above would be satisfied by a planner that finds nothing
      // for any input, and the test would assert the wrong absence.
      expect(planPublication(db, registry, parseAgentIds(`${seller.address}=${agentId}`), publisher.address))
        .to.have.lengthOf(1);
    });

    it("honours a subject filter and a limit", function () {
      insertDeal(db, "1", seller.address, "release");
      insertDeal(db, "2", OTHER, "release");
      const agentIds = parseAgentIds(`${seller.address}=${agentId},${OTHER}=2`);
      expect(planPublication(db, registry, agentIds, publisher.address, { subject: seller.address })).to.have.lengthOf(1);
      expect(planPublication(db, registry, agentIds, publisher.address, { limit: 1 })).to.have.lengthOf(1);
    });

    it("ignores deals that never reached a terminal outcome", function () {
      const dealId = "9";
      db.prepare(`
        INSERT INTO deals (
          deployment, chain_id, contract, deal_id, block_number, buyer, seller, arbiter, verifier, token,
          token_decimals, amount, bond, criteria_hash, deadline, funded_at
        ) VALUES ('erc8004-test', 31337, ?, ?, 9, ?, ?, ?, ?, ?, 2, '1000', '0', ?, 2000000000, 1700000009)
      `).run(TOKEN, dealId, BUYER, seller.address, OTHER, OTHER, TOKEN, `0x${"00".repeat(32)}`);
      expect(planPublication(db, registry, parseAgentIds(`${seller.address}=${agentId}`), publisher.address)).to.deep.equal([]);
    });
  });

  describe("agentId binding", function () {
    it("accepts an agentId whose declared wallet is the subject", async function () {
      const check = await checkAgentId(ethers.provider, registry, agentId, seller.address, publisher.address);
      expect(check.matchesSubject).to.equal(true);
      expect(check.publisherIsOwner).to.equal(false);
    });

    it("rejects an agentId bound to a different wallet", async function () {
      const check = await checkAgentId(ethers.provider, registry, agentId, OTHER, publisher.address);
      expect(check.matchesSubject).to.equal(false);
    });

    // An unminted id and an id with no declared wallet both revert on-chain.
    // Treating a revert as "no binding" is the difference between refusing and
    // publishing against whatever id happened to be passed in.
    it("treats a nonexistent agentId as unbound rather than throwing", async function () {
      const check = await checkAgentId(ethers.provider, registry, "999", seller.address, publisher.address);
      expect(check.wallet).to.equal(null);
      expect(check.owner).to.equal(null);
      expect(check.matchesSubject).to.equal(false);
    });

    it("notices when the publisher owns the agent it is about to rate", async function () {
      await (await asRegistry(identity.connect(publisher)).register("https://example.com/self.json")).wait();
      const check = await checkAgentId(ethers.provider, registry, "2", publisher.address, publisher.address);
      expect(check.publisherIsOwner).to.equal(true);
    });

    // The spec forbids an approved operator as well as the owner; the local check has to
    // read the approval, or the refusal only happens on chain after gas is spent.
    it("notices when the publisher is an approved operator for the agent", async function () {
      await (await asRegistry(identity.connect(seller)).approve(publisher.address, agentId)).wait();
      const check = await checkAgentId(ethers.provider, registry, agentId, seller.address, publisher.address);
      expect(check.publisherIsOwner).to.equal(true);
    });
  });

  describe("publishing", function () {
    it("writes a settled deal into the registry and records it locally", async function () {
      insertDeal(db, "1", seller.address, "release");
      const plans = planPublication(db, registry, parseAgentIds(`${seller.address}=${agentId}`), publisher.address);
      const results = await publish(db, registry, publisher as Wallet, plans);

      expect(results).to.have.lengthOf(1);
      expect(await reputation.feedbackCount(agentId, publisher.address)).to.equal(1n);

      const stored = await reputation.readFeedback(agentId, publisher.address, 1);
      expect(stored[0]).to.equal(BigInt(OUTCOME_VALUE.release));
      expect(stored[1]).to.equal(BigInt(VALUE_DECIMALS));
      expect(stored[2]).to.equal("release");
      expect(stored[4]).to.equal(false);

      const row = db.prepare("SELECT * FROM erc8004_publications").get() as { deal_id: string; tx_hash: string; outcome: string };
      expect(row.deal_id).to.equal("1");
      expect(row.outcome).to.equal("release");
      expect(row.tx_hash).to.equal(results[0].txHash);
    });

    // The finding that makes Sinetti the content and not the competitor: the
    // registry keeps the number and drops the pointer to the real record.
    it("emits the feedbackURI that the registry does not store", async function () {
      insertDeal(db, "1", seller.address, "release");
      const plans = planPublication(db, registry, parseAgentIds(`${seller.address}=${agentId}`), publisher.address);
      const [result] = await publish(db, registry, publisher as Wallet, plans);

      const receipt = await ethers.provider.getTransactionReceipt(result.txHash);
      const parsed = receipt!.logs
        .map((log) => { try { return reputation.interface.parseLog(log); } catch { return null; } })
        .find((log) => log?.name === "NewFeedback");
      expect(parsed!.args.feedbackURI).to.match(/^https:\/\/rep\.sinetti\.ai\/feedback\/eip155:31337:/);

      // Same call, read back from storage: the URI is simply not there.
      const stored = await reputation.readFeedback(agentId, publisher.address, 1);
      expect(Object.values(stored).join(" ")).to.not.contain("rep.sinetti.ai");
    });

    // ERC-8004 has no merge and no edit. A second run that re-sent the same
    // deal would double-count it in every consumer's summary, permanently.
    it("never publishes the same deal twice", async function () {
      insertDeal(db, "1", seller.address, "release");
      const agentIds = parseAgentIds(`${seller.address}=${agentId}`);
      await publish(db, registry, publisher as Wallet, planPublication(db, registry, agentIds, publisher.address));

      expect(planPublication(db, registry, agentIds, publisher.address)).to.deep.equal([]);
      expect(await reputation.feedbackCount(agentId, publisher.address)).to.equal(1n);
    });

    it("refuses to publish against an agentId that is not bound to the subject", async function () {
      insertDeal(db, "1", seller.address, "release");
      const plans = planPublication(db, registry, parseAgentIds(`${seller.address}=${agentId}`), publisher.address);
      plans[0].agentId = "999";
      await rejects(publish(db, registry, publisher as Wallet, plans), /not bound to/);
      expect(db.prepare("SELECT COUNT(*) AS n FROM erc8004_publications").get()).to.deep.equal({ n: 0 });
    });

    it("refuses self-feedback before spending gas on a revert", async function () {
      await (await asRegistry(identity.connect(publisher)).register("https://example.com/self.json")).wait();
      await (await asRegistry(identity.connect(publisher)).setAgentWallet("2", publisher.address)).wait();
      insertDeal(db, "1", publisher.address, "release");
      const plans = planPublication(db, registry, parseAgentIds(`${publisher.address}=2`), publisher.address);
      await rejects(publish(db, registry, publisher as Wallet, plans), /forbids self-feedback/);
    });

    it("records each write before sending the next, so a mid-run failure leaves no unrecorded entry", async function () {
      insertDeal(db, "1", seller.address, "release");
      insertDeal(db, "2", seller.address, "refund");
      const plans = planPublication(db, registry, parseAgentIds(`${seller.address}=${agentId}`), publisher.address);
      plans[1].agentId = "999";

      await rejects(publish(db, registry, publisher as Wallet, plans), /not bound to/);
      expect(await reputation.feedbackCount(agentId, publisher.address)).to.equal(1n);
      expect(db.prepare("SELECT COUNT(*) AS n FROM erc8004_publications").get()).to.deep.equal({ n: 1 });
    });

    it("never sends a deal twice when the receipt was sent but not recorded", async function () {
      insertDeal(db, "1", seller.address, "release");
      const plans = planPublication(db, registry, parseAgentIds(`${seller.address}=${agentId}`), publisher.address);
      // Simulate a crash between broadcast and the receipt being recorded: the
      // confirming UPDATE fails. The transaction is already on chain.
      db.exec("CREATE TRIGGER fail_confirm BEFORE UPDATE OF published_at ON erc8004_publications BEGIN SELECT RAISE(FAIL, 'disk gone'); END");
      await rejects(publish(db, registry, publisher as Wallet, plans), /disk gone/);
      db.exec("DROP TRIGGER fail_confirm");
      expect(await reputation.feedbackCount(agentId, publisher.address)).to.equal(1n);

      // The reservation stands: the deal is out of the plan and publishing is
      // refused until the operator reconciles it.
      const pending = listPendingPublications(db, registry);
      expect(pending).to.have.lengthOf(1);
      expect(pending[0].dealId).to.equal("1");
      expect(pending[0].txHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(planPublication(db, registry, parseAgentIds(`${seller.address}=${agentId}`), publisher.address)).to.have.lengthOf(0);
      insertDeal(db, "2", seller.address, "refund");
      const more = planPublication(db, registry, parseAgentIds(`${seller.address}=${agentId}`), publisher.address);
      expect(more).to.have.lengthOf(1);
      await rejects(publish(db, registry, publisher as Wallet, more), /pending ERC-8004 publications/);
      expect(await reputation.feedbackCount(agentId, publisher.address)).to.equal(1n);
    });

    it("frees the deal when the send itself fails before broadcast", async function () {
      insertDeal(db, "1", seller.address, "release");
      const plans = planPublication(db, registry, parseAgentIds(`${seller.address}=${agentId}`), publisher.address);
      plans[0].agentId = "999";
      await rejects(publish(db, registry, publisher as Wallet, plans), /not bound to/);
      expect(listPendingPublications(db, registry)).to.have.lengthOf(0);
      expect(db.prepare("SELECT COUNT(*) AS n FROM erc8004_publications").get()).to.deep.equal({ n: 0 });
    });

    it("allows the same history to be published to a second registry", async function () {
      insertDeal(db, "1", seller.address, "release");
      const agentIds = parseAgentIds(`${seller.address}=${agentId}`);
      await publish(db, registry, publisher as Wallet, planPublication(db, registry, agentIds, publisher.address));

      const second = { ...registry, chainId: 84532 };
      expect(planPublication(db, second, agentIds, publisher.address)).to.have.lengthOf(1);
    });
  });

  /**
   * "The indexer only calls read methods and no private key is used or
   * accepted" is a stated property of this service, and the publisher is the
   * one thing that breaks it. Keeping them apart is a claim about the import
   * graph, so it is checked as one. A comment would not have caught the day
   * somebody imports a helper from here into the API for convenience.
   */
  describe("key isolation", function () {
    function transitiveImports(entry: string): Set<string> {
      const seen = new Set<string>();
      const queue = [entry];
      while (queue.length > 0) {
        const module = queue.pop()!;
        if (seen.has(module)) continue;
        seen.add(module);
        const source = readFileSync(resolve(process.cwd(), "src", `${module}.ts`), "utf8");
        for (const match of source.matchAll(/from "\.\/([a-zA-Z0-9_-]+)"/g)) queue.push(match[1]);
      }
      return seen;
    }

    // Positive control, first. Every assertion below is an absence, and an
    // absence proves nothing until the thing doing the looking is known to
    // work: a broken regex, a renamed file or an unreadable entry all return
    // an empty set, and an empty set contains no "publisher" either. This is the
    // shape that made 15 fixture failures look like clean passes elsewhere in
    // this repo, so it is checked rather than assumed.
    it("walks the graph it is about to assert an absence over", function () {
      const graph = transitiveImports("api");
      // Reached only at depth 2+: api imports neither of these directly.
      expect([...graph]).to.include("settlement");
      expect([...graph]).to.include("config");
      // And the walker can see the module the tests below look for, so
      // "not found" means absent rather than unfindable.
      expect([...transitiveImports("publisher")]).to.contain("publisher");
    });

    for (const entry of ["index", "api", "indexer", "feedback", "identity", "registries", "standards"]) {
      it(`keeps ${entry}.ts free of the publisher, transitively`, function () {
        const graph = transitiveImports(entry);
        expect([...graph], `${entry}.ts walked to nothing`).to.have.length.greaterThan(1);
        expect([...graph]).to.not.contain("publisher");
      });
    }

    it("reads the signing key from one variable, in one module", function () {
      const sources = readdirSync(resolve(process.cwd(), "src"))
        .filter((file) => file.endsWith(".ts"))
        .filter((file) => readFileSync(resolve(process.cwd(), "src", file), "utf8").includes("ERC8004_PRIVATE_KEY"));
      expect(sources).to.deep.equal(["publisher.ts"]);
    });
  });

  describe("parseAgentIds", function () {
    it("checksums addresses and rejects malformed pairs", function () {
      expect([...parseAgentIds(`${seller.address.toLowerCase()}=7`).keys()])
        .to.deep.equal([getAddress(seller.address)]);
      expect(() => parseAgentIds("0xabc")).to.throw(/Malformed/);
      expect(() => parseAgentIds(`${seller.address}=not-a-number`)).to.throw(/Malformed/);
    });
  });
});
