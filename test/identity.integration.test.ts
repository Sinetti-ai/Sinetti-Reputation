import { expect } from "chai";
import { ethers } from "hardhat";
import request from "supertest";
import { HDNodeWallet, Provider, Wallet, encodeBytes32String, getAddress, keccak256, toUtf8Bytes } from "ethers";
import { createApp } from "../src/api";
import { openDatabase } from "../src/db";
import { Fetcher, checkFeedbackFiles, indexRegistryFeedback } from "../src/feedback";
import { agentCard, agentIdentity, agentsNamed, checkAgentFiles, indexRegistryIdentity, listAgentDirectory, searchAgents } from "../src/identity";
import { forgetHoles } from "../src/logs";
import { KNOWN_REGISTRIES, RegistryConfig } from "../src/registries";
import { registerAgent } from "../scripts/register-erc8004";

const ESCROW = getAddress("0x0000000000000000000000000000000000000E5C");
const TOKEN = "0x0000000000000000000000000000000000000001";
const ZERO_HASH = `0x${"00".repeat(32)}`;

interface MockIdentity {
  register(agentURI: string): Promise<{ wait(): Promise<unknown> }>;
  setAgentURI(agentId: string, uri: string): Promise<{ wait(): Promise<unknown> }>;
}
interface MockReputation {
  giveFeedback(agentId: string, value: number, decimals: number, tag1: string, tag2: string, endpoint: string, uri: string, hash: string): Promise<{ wait(): Promise<unknown> }>;
}

describe("ERC-8004 identity directory", function () {
  let db: ReturnType<typeof openDatabase>;
  let registry: RegistryConfig;
  let identity: Awaited<ReturnType<typeof deploy>>["identity"];
  let reputation: Awaited<ReturnType<typeof deploy>>["reputation"];
  let owner: HDNodeWallet;
  let buyer: HDNodeWallet;
  const files = new Map<string, string>();
  const fetched: string[] = [];
  const fetcher: Fetcher = async (url) => {
    fetched.push(url);
    const body = files.get(url);
    return body === undefined ? { status: 404, body: new Uint8Array() } : { status: 200, body: new TextEncoder().encode(body) };
  };
  let clock = 1_700_000_000;
  const now = () => clock;

  async function deploy() {
    const identityContract = await (await ethers.getContractFactory("MockIdentityRegistry")).deploy();
    await identityContract.waitForDeployment();
    const reputationContract = await (await ethers.getContractFactory("MockReputationRegistry")).deploy(await identityContract.getAddress());
    await reputationContract.waitForDeployment();
    return { identity: identityContract, reputation: reputationContract };
  }

  async function register(from: HDNodeWallet, uri: string): Promise<void> {
    await (await (identity.connect(from) as unknown as MockIdentity).register(uri)).wait();
  }

  async function readAll(): Promise<number> {
    await indexRegistryIdentity(db, registry, { provider: ethers.provider });
    return checkAgentFiles(db, registry, { fetcher, now });
  }

  const CARD_URL = "https://helper.example/.well-known/agent-card.json";
  function helperFiles(agentId: string): void {
    files.set("https://helper.example/registration.json", JSON.stringify({
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "Helper", description: "Translates and summarises.", active: true,
      services: [{ name: "A2A", endpoint: CARD_URL, version: "0.3.0" }, { name: "MCP", endpoint: "https://helper.example/mcp" }],
      registrations: [{ agentId: Number(agentId), agentRegistry: `eip155:31337:${registry.identityRegistry}` }]
    }));
    files.set(CARD_URL, JSON.stringify({
      name: "Helper", url: "https://helper.example/a2a", version: "1.0.0",
      capabilities: { streaming: true },
      skills: [{ id: "translate", name: "Translate", tags: ["nlp"] }, { id: "summarise", name: "Summarise", tags: [] }]
    }));
  }

  beforeEach(async function () {
    forgetHoles();
    db = openDatabase(":memory:");
    files.clear();
    fetched.length = 0;
    clock = 1_700_000_000;
    ({ identity, reputation } = await deploy());
    registry = {
      name: "hardhat", chainId: 31337, fromBlock: 0, identityFromBlock: 0, firstAgentId: 1, confirmations: 0, rpcUrl: "unused",
      reputationRegistry: getAddress(await reputation.getAddress()),
      identityRegistry: getAddress(await identity.getAddress())
    };
    const [funder] = await ethers.getSigners();
    owner = Wallet.createRandom().connect(ethers.provider);
    buyer = Wallet.createRandom().connect(ethers.provider);
    for (const wallet of [owner, buyer]) {
      await (await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther("1") })).wait();
    }
  });

  afterEach(function () {
    db.close();
  });

  it("indexes registrations, reads the file and the agent card, and flags nothing on a consistent agent", async function () {
    helperFiles("1");
    await register(owner, "https://helper.example/registration.json");
    expect(await readAll()).to.equal(1);

    const card = agentIdentity(db, registry, "1")!;
    expect(card.owner).to.equal(owner.address);
    expect(card.file_status).to.equal("ok");
    expect(card.declared!.name).to.equal("Helper");
    expect(card.declared!.services.map((service) => service.name)).to.deep.equal(["A2A", "MCP"]);
    expect(card.card_url).to.equal(CARD_URL);
    expect(card.card!.skills.map((skill) => skill.id)).to.deep.equal(["translate", "summarise"]);
    expect(card.card!.signed).to.equal(false);
    expect(card.flags).to.deep.equal([]);
    expect(card.fetched_at).to.equal(clock);
  });

  it("records an unreachable or malformed file as such and still lists the agent", async function () {
    await register(owner, "https://gone.example/agent.json");
    files.set("https://bad.example/agent.json", "not json");
    await register(buyer, "https://bad.example/agent.json");
    await register(owner, "http://plain.example/agent.json");
    await readAll();

    const directory = listAgentDirectory(db, registry);
    expect(directory.agents.map((agent) => [agent.agent_id, agent.name, agent.file_status])).to.deep.equal([
      ["1", null, "unreachable"], ["2", null, "invalid_json"], ["3", null, "scheme_refused"]
    ]);
    expect(agentIdentity(db, registry, "1")!.declared).to.equal(null);
  });

  it("flags a file that does not name the agentId it hangs off, and the legacy endpoints key", async function () {
    files.set("https://other.example/agent.json", JSON.stringify({
      name: "Other", endpoints: [{ name: "web", endpoint: "https://other.example" }],
      registrations: [{ agentId: 99, agentRegistry: `eip155:31337:${registry.identityRegistry}` }]
    }));
    await register(owner, "https://other.example/agent.json");
    await readAll();
    expect(agentIdentity(db, registry, "1")!.flags).to.deep.equal(["registrations_missing", "legacy_endpoints_key"]);
  });

  it("flags an agent card whose own url sits on a different host from the declared endpoint", async function () {
    files.set("https://a.example/agent.json", JSON.stringify({
      name: "Split", services: [{ name: "A2A", endpoint: "https://a.example/card.json" }], registrations: [{ agentId: 1 }]
    }));
    files.set("https://a.example/card.json", JSON.stringify({ name: "Split", url: "https://b.example/a2a", skills: [] }));
    await register(owner, "https://a.example/agent.json");
    await readAll();
    expect(agentIdentity(db, registry, "1")!.flags).to.deep.equal(["card_host_mismatch"]);
  });

  it("re-reads an agent when its URI moves and again after the refresh interval, and otherwise leaves it alone", async function () {
    helperFiles("1");
    await register(owner, "https://helper.example/registration.json");
    await readAll();
    expect(fetched).to.have.length(2);

    expect(await readAll()).to.equal(0);
    expect(fetched).to.have.length(2);

    files.set("https://helper.example/v2.json", JSON.stringify({ name: "Helper v2", services: [], registrations: [{ agentId: 1 }] }));
    await (await (identity.connect(owner) as unknown as MockIdentity).setAgentURI("1", "https://helper.example/v2.json")).wait();
    expect(await readAll()).to.equal(1);
    expect(agentIdentity(db, registry, "1")!.declared!.name).to.equal("Helper v2");
    expect(agentIdentity(db, registry, "1")!.card).to.equal(null);

    clock += 86_401;
    expect(await readAll()).to.equal(1);
    expect(agentIdentity(db, registry, "1")!.fetched_at).to.equal(clock);
  });

  it("checks in bounded batches with several files in flight", async function () {
    for (let i = 0; i < 5; i += 1) {
      files.set(`https://many.example/${i}.json`, JSON.stringify({ name: `Agent ${i}` }));
      await register(owner, `https://many.example/${i}.json`);
    }
    await indexRegistryIdentity(db, registry, { provider: ethers.provider });
    // A fetcher that only resolves once every worker has asked: with fewer
    // than `concurrency` in flight it would never return.
    let waiting: Array<() => void> = [];
    let peak = 0;
    const gated: Fetcher = (url) => new Promise((resolve) => {
      waiting.push(() => resolve(fetcher(url)));
      peak = Math.max(peak, waiting.length);
      if (waiting.length === 2) { const release = waiting; waiting = []; for (const go of release) go(); }
    });
    expect(await checkAgentFiles(db, registry, { fetcher: gated, now, limit: 2, concurrency: 2 })).to.equal(2);
    expect(peak).to.equal(2);
    expect(await checkAgentFiles(db, registry, { fetcher, now, limit: 2, concurrency: 8 })).to.equal(2);
    expect(await checkAgentFiles(db, registry, { fetcher, now, limit: 2, concurrency: 8 })).to.equal(1);
    expect(listAgentDirectory(db, registry).agents.every((agent) => agent.file_status === "ok")).to.equal(true);
  });

  it("drops a read whose URI moved while it was in flight, and reads the new URI first", async function () {
    for (let i = 0; i < 3; i += 1) {
      files.set(`https://slow.example/${i}.json`, JSON.stringify({ name: `Slow ${i}` }));
      await register(owner, `https://slow.example/${i}.json`);
    }
    await indexRegistryIdentity(db, registry, { provider: ethers.provider });
    // The old URI is fetched; before its result is recorded, the agent moves.
    const racing: Fetcher = async (url) => {
      if (url === "https://slow.example/0.json") {
        files.set("https://slow.example/moved.json", JSON.stringify({ name: "Moved" }));
        await (await (identity.connect(owner) as unknown as MockIdentity).setAgentURI("1", "https://slow.example/moved.json")).wait();
        await indexRegistryIdentity(db, registry, { provider: ethers.provider });
      }
      return fetcher(url);
    };
    await checkAgentFiles(db, registry, { fetcher: racing, now, limit: 1, concurrency: 1 });
    expect(agentIdentity(db, registry, "1")!.file_status).to.equal("pending");
    expect(agentIdentity(db, registry, "1")!.declared).to.equal(null);
    // The pending re-read goes ahead of never-read agents 2 and 3.
    await checkAgentFiles(db, registry, { fetcher, now, limit: 1 });
    expect(agentIdentity(db, registry, "1")!.declared!.name).to.equal("Moved");
    expect(agentIdentity(db, registry, "2")!.file_status).to.equal("pending");
  });

  it("orders the directory by verified ratings, searches names case-insensitively, and escapes LIKE wildcards", async function () {
    helperFiles("2");
    files.set("https://quiet.example/agent.json", JSON.stringify({ name: "Quiet 100% helper", active: false, registrations: [{ agentId: 1 }] }));
    await register(buyer, "https://quiet.example/agent.json");
    await register(owner, "https://helper.example/registration.json");
    await readAll();

    // Agent 2 gets one verified rating from a settled deal, so it leads the directory.
    db.prepare(`INSERT INTO deals (deployment, chain_id, contract, deal_id, block_number, buyer, seller, arbiter, verifier, token,
      token_decimals, amount, bond, criteria_hash, deadline, funded_at) VALUES ('escrow-test', 31337, ?, '1', 1, ?, ?, ?, ?, ?, 2, '1000', '0', ?, 2000000000, 1700000000)`)
      .run(ESCROW, buyer.address, owner.address, buyer.address, buyer.address, TOKEN, ZERO_HASH);
    db.prepare(`INSERT INTO raw_events (deployment, chain_id, contract, tx_hash, log_index, block_number, block_timestamp, deal_id, event_name, args_json)
      VALUES ('escrow-test', 31337, ?, ?, 0, 2, 1700000100, '1', 'Settled', ?)`).run(ESCROW, `0x${"1".padStart(64, "0")}`, JSON.stringify({ reason: encodeBytes32String("accepted") }));
    const body = JSON.stringify({ settlement: { chainId: 31337, contract: ESCROW, dealId: "1" }, skills: ["translate", "unknown-skill"], taskId: "task-1" });
    files.set("https://buyer.example/f.json", body);
    await (await (reputation.connect(buyer) as unknown as MockReputation).giveFeedback("2", 100, 0, "release", "", "", "https://buyer.example/f.json", keccak256(toUtf8Bytes(body)))).wait();
    await indexRegistryFeedback(db, registry, { provider: ethers.provider });
    await checkFeedbackFiles(db, registry, { provider: ethers.provider, fetcher });

    const directory = listAgentDirectory(db, registry);
    expect(directory.agents.map((agent) => [agent.agent_id, agent.name, agent.active, agent.verified, agent.total])).to.deep.equal([
      ["2", "Helper", true, 1, 1], ["1", "Quiet 100% helper", false, 0, 0]
    ]);
    expect(searchAgents(db, registry, "HELPER").map((agent) => agent.agent_id)).to.deep.equal(["2", "1"]);
    expect(searchAgents(db, registry, "100%").map((agent) => agent.agent_id)).to.deep.equal(["1"]);
    expect(searchAgents(db, registry, "100_").map((agent) => agent.agent_id)).to.deep.equal([]);
    expect(searchAgents(db, registry, "   ")).to.deep.equal([]);

    // The full card names the skill from the agent card and marks the one it does not list.
    const card = agentCard(db, registry, "2")!;
    expect(card.entries[0].skills).to.deep.equal([{ id: "translate", name: "Translate" }, { id: "unknown-skill", name: null }]);
    expect(card.entries[0].task_id).to.equal("task-1");
    expect(card.identity!.declared!.name).to.equal("Helper");
    // An agent with a registration and no rating still has a card.
    expect(agentCard(db, registry, "1")!.feedback.total).to.equal(0);
    expect(agentCard(db, registry, "3")).to.equal(null);
  });

  it("collapses one owner's agents that declare the same name into one row, and keeps another owner's apart", async function () {
    helperFiles("1");
    files.set("https://twin.example/registration.json", JSON.stringify({
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "helper", active: true, services: [],
      registrations: [{ agentId: 2, agentRegistry: `eip155:31337:${registry.identityRegistry}` }]
    }));
    files.set("https://squat.example/registration.json", JSON.stringify({
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "Helper", active: true, services: [],
      registrations: [{ agentId: 3, agentRegistry: `eip155:31337:${registry.identityRegistry}` }]
    }));
    await register(owner, "https://helper.example/registration.json");
    await register(owner, "https://twin.example/registration.json");
    await register(buyer, "https://squat.example/registration.json");
    await readAll();

    // The owner's two "Helper" registrations fold into #1; the buyer's "Helper" is another party and keeps its row.
    const directory = listAgentDirectory(db, registry);
    expect(directory.pages).to.equal(1);
    expect(directory.agents.map((agent) => [agent.agent_id, agent.name, agent.registrations])).to.deep.equal([
      ["1", "Helper", 2], ["3", "Helper", 1]
    ]);
    expect(searchAgents(db, registry, "help").map((agent) => [agent.agent_id, agent.registrations])).to.deep.equal([["1", 2], ["3", 1]]);
    expect(agentsNamed(db, registry, "HELPER")).to.deep.equal(["1", "2", "3"]);
  });

  describe("API and pages", function () {
    it("serves the directory, search, the merged card and the name lookup", async function () {
      const saved = KNOWN_REGISTRIES.hardhat;
      KNOWN_REGISTRIES.hardhat = { ...registry };
      try {
        helperFiles("1");
        await register(owner, "https://helper.example/registration.json");
        files.set("https://other.example/agent.json", JSON.stringify({ name: "Helper", registrations: [{ agentId: 2 }] }));
        await register(buyer, "https://other.example/agent.json");
        await readAll();
        const app = createApp(db);

        const directory = await request(app).get("/registries/hardhat/directory").expect(200);
        expect(directory.body.pages).to.equal(1);
        // Both declare "Helper" but belong to different owners: two rows.
        expect(directory.body.agents.map((agent: { agent_id: string; registrations: number }) => [agent.agent_id, agent.registrations])).to.deep.equal([["1", 1], ["2", 1]]);

        const search = await request(app).get("/registries/hardhat/search?q=help").expect(200);
        expect(search.body.agents).to.have.length(2);
        await request(app).get("/registries/hardhat/search").expect(400);
        await request(app).get("/registries/nowhere/directory").expect(404);

        const card = await request(app).get("/registries/hardhat/agents/1").expect(200);
        expect(card.body.identity.declared.name).to.equal("Helper");
        expect(card.body.identity.card.skills[0].id).to.equal("translate");
        expect(card.body.feedback.total).to.equal(0);

        // Pages for people are mounted by a hosted instance's extension; the public reader answers 404.
        await request(app).get("/r/hardhat/1").expect(404);
        await request(app).get("/search?q=Helper").expect(404);
        // A second agent with the same declared name still lists, since names are not unique.
        files.set("https://other.example/agent.json", JSON.stringify({ name: "Someone else", registrations: [{ agentId: 2 }] }));
        clock += 86_401;
        await readAll();
        await request(app).get("/registries/hardhat/directory?page=0").expect(200);
        await request(app).get("/registries/hardhat/search?q=nobody").expect(200);
        for (const name of ["constructor", "__proto__"]) {
          await request(app).get(`/registries/${name}/directory`).expect(404);
          await request(app).get(`/registries/${name}/search?q=a`).expect(404);
        }
      } finally {
        if (saved) KNOWN_REGISTRIES.hardhat = saved; else delete KNOWN_REGISTRIES.hardhat;
      }
    });
  });

  it("repairs an id hole a wide getLogs window answered without", async function () {
    await register(owner, "https://one.example/agent.json");
    await register(buyer, "https://two.example/agent.json");
    await register(owner, "https://three.example/agent.json");
    const holeTopic = `0x${"0".repeat(63)}2`;
    let repairCalls = 0;
    // Chunk-pass filters carry one topic position; the RPC "loses" agent 2 from those.
    // Filters that name agent ids (the repair pass) answer in full.
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
            return logs.filter((log) => log.topics[1] !== holeTopic);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as unknown as Provider;

    const result = await indexRegistryIdentity(db, registry, { provider: lossy });
    expect(repairCalls).to.equal(1);
    expect(result.repaired).to.equal(1);
    expect(result.missing).to.equal(0);
    expect(listAgentDirectory(db, registry).agents.map((agent) => agent.agent_id).sort()).to.deep.equal(["1", "2", "3"]);
  });

  it("registers a wallet through the register script and the directory reads it without flags", async function () {
    const agentId = await registerAgent(owner, registry.chainId, registry.identityRegistry, { name: "Seed seller", description: "Test seller for deal 6." });
    expect(agentId).to.equal("1");
    await readAll();
    const card = agentIdentity(db, registry, "1")!;
    expect(card.owner).to.equal(owner.address);
    expect(card.file_status).to.equal("ok");
    expect(card.declared!.name).to.equal("Seed seller");
    expect(card.flags).to.deep.equal([]);
  });
});
