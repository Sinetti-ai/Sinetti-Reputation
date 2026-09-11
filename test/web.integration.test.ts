import { expect } from "chai";
import { encodeBytes32String, Wallet } from "ethers";
import request from "supertest";
import { createApp } from "../src/api";
import { StoredDeal, openDatabase } from "../src/db";

const TOKEN = "0x0000000000000000000000000000000000000001";
const CRITERIA = `0x${"00".repeat(32)}`;
const SETTLED_AMOUNT = "987654321";

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
    deployment: "web-test",
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
    amount: SETTLED_AMOUNT,
    bond: "0",
    criteria_hash: CRITERIA,
    deadline: 2_000_000_000,
    funded_at: 1_700_000_000
  };
}

describe("human-facing web integration", function () {
  let db: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof createApp>;

  beforeEach(function () {
    db = openDatabase(":memory:");
    app = createApp(db);
  });

  afterEach(function () {
    db.close();
  });

  it("serves the home page with HTML and a restrictive CSP", async function () {
    const response = await request(app).get("/").expect(200);

    expect(response.headers["content-type"]).to.include("text/html");
    expect(response.headers["content-security-policy"]).to.include("default-src 'none'");
    // The lookup box submits to /lookup on this origin and nowhere else.
    expect(response.headers["content-security-policy"]).to.include("form-action 'self'");
    expect(response.headers["content-security-policy"]).to.include("script-src 'sha256-");
    expect(response.text).to.include("needs no account, no signature, and no session");
    expect(response.text).to.include('href="/terms"');
  });

  it("serves the combined terms and privacy notice", async function () {
    const response = await request(app).get("/terms").expect(200);

    expect(response.headers["content-type"]).to.include("text/html");
    expect(response.text).to.include("Draft — pending legal review");
    expect(response.text).to.include("Financial Network Analytics Ltd");
    expect(response.text).to.include("company number 08679188, registered office Albert House, 256-260 Old Street, London EC1V 9DD");
    expect(response.text).to.include("These draft terms will govern use of Sinetti Reputation once they are in force");
    expect(response.text).to.include("On-chain records are public by nature and cannot be removed by FNA");
    expect(response.text).to.include("no accounts and no contact details");
    expect(response.text).to.include("This site sets no cookies of any kind");
    expect(response.text).to.include("Settled-deal history is wash-tradeable in principle");
    expect(response.text).to.include("experimental testnet pilot");
    expect(response.text).to.include("no real-world monetary value");
    expect(response.text).to.include("will be provided “as is”");
    expect(response.text).to.include("courts of England and Wales will have exclusive jurisdiction");
    expect(response.text).to.include("team@sinetti.ai");

    // The account layer is gone, so the notice must not keep promising the
    // account-shaped obligations that came with it.
    expect(response.text).not.to.include("signup data");
    expect(response.text).not.to.include("retention sweeps");
    expect(response.text).not.to.include("delete their account");
    expect(response.text).not.to.include("agent-key records");
  });

  it("serves llms.txt as plain text rather than HTML", async function () {
    const response = await request(app).get("/llms.txt").expect(200);

    expect(response.headers["content-type"]).to.equal("text/plain; charset=utf-8");
    expect(response.text).not.to.match(/<html|<!doctype/i);
    expect(response.text).to.include("The API is read-only and entirely unauthenticated");
    expect(response.text).to.include("recomputable by anyone running this indexer");
    expect(response.text).to.include("Settled-deal history is wash-tradeable in principle");
    expect(response.text).to.include("GET /terms");

    // No auth surface left to document.
    expect(response.text).not.to.include("POST /auth/");
    expect(response.text).not.to.include("/account/");
    expect(response.text).not.to.include("Bearer");
  });

  it("serves the same card to every reader, with no session to vary it", async function () {
    const owner = Wallet.createRandom();
    const other = Wallet.createRandom();
    const arbiter = Wallet.createRandom();
    const verifier = Wallet.createRandom();
    insertCardDeal(db, makeDeal(owner.address, other.address, arbiter.address, verifier.address));

    const anonymous = await request(app).get(`/a/${owner.address}`).expect(200);
    const withStaleBearer = await request(app)
      .get(`/a/${owner.address}`)
      .set("Authorization", "Bearer any-token-at-all")
      .expect(200);
    const withStaleCookie = await request(app)
      .get(`/a/${owner.address}`)
      .set("Cookie", "sinetti_rep_view_session=anything")
      .expect(200);

    expect(anonymous.headers["content-type"]).to.include("text/html");
    expect(anonymous.text).to.include(owner.address);
    // Bonds and roles are on the card now: they are derived from public chain
    // events, so gating them behind a session protected nothing.
    expect(anonymous.text).to.include("Bonds posted");
    expect(anonymous.text).to.include("Deals as buyer");
    // Volume stays withheld to reduce wallet financial profiling.
    expect(anonymous.text).not.to.include(SETTLED_AMOUNT);
    expect(withStaleBearer.text).to.equal(anonymous.text);
    expect(withStaleCookie.text).to.equal(anonymous.text);
  });

  it("sets no cookies on any page", async function () {
    const owner = Wallet.createRandom();
    insertCardDeal(db, makeDeal(
      owner.address,
      Wallet.createRandom().address,
      Wallet.createRandom().address,
      Wallet.createRandom().address
    ));

    for (const path of ["/", "/terms", "/llms.txt", `/a/${owner.address}`]) {
      const response = await request(app).get(path).expect(200);
      expect(response.headers["set-cookie"], `${path} set a cookie`).to.equal(undefined);
    }
  });

  it("carries no demo or testnet banner on a public card", async function () {
    const owner = Wallet.createRandom();
    insertCardDeal(db, makeDeal(owner.address, Wallet.createRandom().address, Wallet.createRandom().address, Wallet.createRandom().address));
    const response = await request(app).get(`/a/${owner.address}`).expect(200);
    expect(response.text).to.not.match(/not real funds|unaudited|testnet-banner/i);
  });

  it("returns HTML 404 pages for unknown and malformed addresses", async function () {
    const unknown = await request(app).get(`/a/${Wallet.createRandom().address}`).expect(404);
    expect(unknown.headers["content-type"]).to.include("text/html");
    expect(unknown.text).to.include("Card not found");

    const malformed = await request(app).get("/a/not-a-valid-address").expect(404);
    expect(malformed.headers["content-type"]).to.include("text/html");
    expect(malformed.text).to.include("Card not found");
  });

  it("serves registry pages and a 404 for an unknown agent", async function () {
    const home = await request(app).get("/").expect(200);
    expect(home.text).to.include("Attested feedback for ERC-8004");
    expect(home.text).to.include("/registries/{registry}/agents/{agentId}");

    const registry = await request(app).get("/r/ethereum-sepolia").expect(200);
    expect(registry.text).to.include("Verified. Agents with at least one rating that names a settled deal.");
    expect(registry.text).to.include("None yet.");
    expect(registry.text).to.include("No registrations indexed yet.");

    // The lookup box accepts either kind of card.
    const byAgent = await request(app).get("/lookup?q=ethereum-sepolia/42").expect(302);
    expect(byAgent.headers.location).to.equal("/r/ethereum-sepolia/42");
    const byWallet = await request(app).get(`/lookup?q=${Wallet.createRandom().address.toLowerCase()}`).expect(302);
    expect(byWallet.headers.location).to.match(/^\/a\/0x/);
    // Anything else is a name search.
    const byName = await request(app).get("/lookup?q=nonsense").expect(302);
    expect(byName.headers.location).to.equal("/search?q=nonsense");
    const icon = await request(app).get("/favicon.svg").expect(200);
    expect(icon.headers["content-type"]).to.include("image/svg+xml");

    await request(app).get("/r/ethereum-sepolia/1").expect(404);
    await request(app).get("/r/nowhere").expect(404);
    await request(app).get("/r/ethereum-sepolia/not-a-number").expect(404);
  });

  it("no longer exposes the account and view-code surface", async function () {
    // Anchored on a live route first: these are all absence assertions, and a
    // web surface that failed to mount would 404 on everything and pass.
    await request(app).get("/").expect(200);

    await request(app).get("/my-card").expect(404);
    await request(app).post("/view-code/redeem").type("form").send({ code: "ANYTHING" }).expect(404);
    await request(app).post("/auth/challenge").send({ address: Wallet.createRandom().address }).expect(404);
    await request(app).get("/account/agent-keys").expect(404);
  });
});
