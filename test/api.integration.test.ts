import { expect } from "chai";
import { encodeBytes32String, Wallet } from "ethers";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import request from "supertest";
import { createApp } from "../src/api";
import { StoredDeal, openDatabase } from "../src/db";

const TOKEN = "0x0000000000000000000000000000000000000001";
const CRITERIA = `0x${"00".repeat(32)}`;

function insertCardDeal(db: ReturnType<typeof openDatabase>, deal: StoredDeal): void {
  db.prepare(`
    INSERT INTO deals (
      deployment, chain_id, contract, deal_id, block_number, buyer, seller, arbiter, verifier, token,
      token_decimals, amount, bond, criteria_hash, deadline, funded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    deal.deployment, deal.chain_id, deal.contract, deal.deal_id, deal.block_number,
    deal.buyer, deal.seller, deal.arbiter, deal.verifier,
    deal.token, deal.token_decimals, deal.amount, deal.bond, deal.criteria_hash, deal.deadline, deal.funded_at
  );
  const txHash = `0x${deal.deal_id.padStart(64, "0")}`;
  for (const [logIndex, event] of [
    [0, { name: "Settled", args: { reason: encodeBytes32String("verdict_pass") } }]
  ] as const) {
    db.prepare(`
      INSERT INTO raw_events (
        deployment, chain_id, contract, tx_hash, log_index, block_number,
        block_timestamp, deal_id, event_name, args_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deal.deployment, deal.chain_id, deal.contract, txHash, logIndex, Number(deal.deal_id),
      deal.funded_at, deal.deal_id, event.name, JSON.stringify(event.args)
    );
  }
}

function makeDeal(target: string, seller: string, arbiter: string, verifier: string): StoredDeal {
  return {
    deployment: "api-test",
    chain_id: 31337,
    contract: TOKEN,
    deal_id: "1",
    block_number: 1,
    buyer: target,
    seller,
    arbiter,
    verifier,
    token: TOKEN,
    token_decimals: 2,
    amount: "100",
    bond: "0",
    criteria_hash: CRITERIA,
    deadline: 2_000_000_000,
    funded_at: 1_700_000_000
  };
}

function validateCard(body: unknown): void {
  const schema = JSON.parse(readFileSync(resolve(process.cwd(), "schemas/reputation-card.schema.json"), "utf8"));
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  expect(ajv.validate(schema, body), JSON.stringify(ajv.errors)).to.equal(true);
}

describe("HTTP API integration", function () {
  let db: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof createApp>;

  beforeEach(function () {
    db = openDatabase(":memory:");
    app = createApp(db);
  });

  afterEach(function () {
    db.close();
  });

  it("serves a schema-valid card to an unauthenticated reader", async function () {
    const target = Wallet.createRandom();
    insertCardDeal(db, makeDeal(
      target.address,
      Wallet.createRandom().address,
      Wallet.createRandom().address,
      Wallet.createRandom().address
    ));

    const response = await request(app).get(`/agents/${target.address}`).expect(200);
    validateCard(response.body);
    expect(response.body.address).to.equal(target.address);
    expect(response.body.deals_settled).to.equal(1);
    expect(response.body).to.have.property("bonds");
    expect(response.body).to.have.property("roles");
    expect(response.body).not.to.have.property("settled_volume");
    expect(response.body).not.to.have.property("contacts");
    expect(response.body).not.to.have.property("agent_identity");
  });

  it("serves an identical card regardless of any credential presented", async function () {
    const target = Wallet.createRandom();
    insertCardDeal(db, makeDeal(
      target.address,
      Wallet.createRandom().address,
      Wallet.createRandom().address,
      Wallet.createRandom().address
    ));

    const anonymous = await request(app).get(`/agents/${target.address}`).expect(200);
    const withBearer = await request(app)
      .get(`/agents/${target.address}`)
      .set("Authorization", "Bearer whatever")
      .expect(200);

    expect(withBearer.body).to.deep.equal(anonymous.body);
  });

  it("lists indexed addresses without a session", async function () {
    const buyer = Wallet.createRandom();
    const seller = Wallet.createRandom();
    insertCardDeal(db, makeDeal(
      buyer.address,
      seller.address,
      Wallet.createRandom().address,
      Wallet.createRandom().address
    ));

    const response = await request(app).get("/agents").expect(200);
    const addresses = (response.body.agents as Array<{ address: string }>).map((agent) => agent.address);
    expect(addresses).to.include(buyer.address);
    expect(addresses).to.include(seller.address);
  });

  it("returns 400 for a malformed address and 404 for an unindexed one", async function () {
    await request(app).get("/agents/not-an-address").expect(400);
    await request(app).get(`/agents/${Wallet.createRandom().address}`).expect(404);
  });

  it("reports health without a database read", async function () {
    const response = await request(app).get("/health").expect(200);
    expect(response.body).to.deep.equal({ status: "ok", operators: { verifier: [], arbiter: [] } });
  });

  it("returns a client error for malformed JSON instead of crashing the request", async function () {
    const response = await request(app)
      .post("/agents")
      .set("Content-Type", "application/json")
      .send("{ not json");
    expect(response.status).to.be.oneOf([400, 404]);
  });

  it("no longer serves the auth and account surface", async function () {
    // Anchored on a live route first. Every assertion below is an absence, and
    // an app that failed to mount at all would 404 on everything and pass.
    await request(app).get("/health").expect(200);

    const address = Wallet.createRandom().address;
    await request(app).post("/auth/challenge").send({ address }).expect(404);
    await request(app).post("/auth/verify").send({ address }).expect(404);
    await request(app).post("/auth/logout").expect(404);
    await request(app).get("/account/agent-keys").expect(404);
    await request(app).post("/account/wallets").send({ address }).expect(404);
    await request(app).post("/account/contacts").send({ kind: "email", value: "a@b.test" }).expect(404);
    await request(app).post("/account/view-codes").expect(404);
    await request(app).get("/account/export").expect(404);
    await request(app).delete("/account").expect(404);
    await request(app).patch("/account/settled-volume").send({ display: true }).expect(404);
  });
});
