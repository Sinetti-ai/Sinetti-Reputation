import { expect } from "chai";
import { encodeBytes32String, Wallet } from "ethers";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { aggregateReputation, publicCard } from "../src/aggregator";
import { StoredDeal, openDatabase } from "../src/db";

const TOKEN = "0x0000000000000000000000000000000000000001";
const OTHER_TOKEN = "0x0000000000000000000000000000000000000002";
const CRITERIA = `0x${"00".repeat(32)}`;

function addResolvedDeal(db: ReturnType<typeof openDatabase>, deal: StoredDeal, index: number): void {
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
  const txHash = `0x${index.toString(16).padStart(64, "0")}`;
  const events = [
    { event_name: "Settled", args: { reason: encodeBytes32String("verdict_pass") } }
  ];
  events.forEach((event, logIndex) => {
    db.prepare(`
      INSERT INTO raw_events (
        deployment, chain_id, contract, tx_hash, log_index, block_number,
        block_timestamp, deal_id, event_name, args_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deal.deployment, deal.chain_id, deal.contract, txHash, logIndex, deal.block_number,
      deal.funded_at, deal.deal_id, event.event_name, JSON.stringify(event.args)
    );
  });
}

function deal(
  id: number,
  buyer: string,
  seller: string,
  arbiter: string,
  verifier: string
): StoredDeal {
  return {
    deployment: "synthetic",
    chain_id: 31337,
    contract: TOKEN,
    deal_id: String(id),
    block_number: id,
    buyer,
    seller,
    arbiter,
    verifier,
    token: TOKEN,
    token_decimals: 2,
    amount: "100",
    bond: "0",
    criteria_hash: CRITERIA,
    deadline: 2_000_000_000,
    funded_at: 1_700_000_000 + id
  };
}

describe("counterparty graph and Slice 2 card fields", function () {
  const previousVerifierEnv = process.env.OPERATOR_VERIFIER_ADDRESSES;
  const previousArbiterEnv = process.env.OPERATOR_ARBITER_ADDRESSES;

  afterEach(function () {
    if (previousVerifierEnv === undefined) delete process.env.OPERATOR_VERIFIER_ADDRESSES;
    else process.env.OPERATOR_VERIFIER_ADDRESSES = previousVerifierEnv;
    if (previousArbiterEnv === undefined) delete process.env.OPERATOR_ARBITER_ADDRESSES;
    else process.env.OPERATOR_ARBITER_ADDRESSES = previousArbiterEnv;
  });

  it("does not treat a self-dealing clique as independent reputation", function () {
    const db = openDatabase(":memory:");
    const members = Array.from({ length: 4 }, () => Wallet.createRandom().address);
    for (let index = 0; index < 4; index += 1) {
      addResolvedDeal(db, deal(index, members[index], members[(index + 1) % 4], members[(index + 2) % 4], members[(index + 3) % 4]), index + 1);
    }

    for (const member of members) {
      const card = aggregateReputation(db, member)!;
      expect(card.graph.distinct_counterparties).to.be.at.most(3);
      expect(card.graph.independent_counterparty_share).to.equal(0);
      expect(card.trust_tier).not.to.equal("reputation_bearing");
    }
    db.close();
  });

  it("recognizes diverse counterparties, provenance, and schema-valid cards", function () {
    const db = openDatabase(":memory:");
    const target = Wallet.createRandom().address;
    const operatorVerifier = Wallet.createRandom().address;
    const fixedArbiter = Wallet.createRandom().address;
    const independentVerifier = Wallet.createRandom().address;
    process.env.OPERATOR_VERIFIER_ADDRESSES = operatorVerifier;
    delete process.env.OPERATOR_ARBITER_ADDRESSES;

    for (let index = 0; index < 5; index += 1) {
      const counterparty = Wallet.createRandom().address;
      const otherParty = Wallet.createRandom().address;
      addResolvedDeal(
        db,
        deal(index, target, counterparty, fixedArbiter, index === 0 ? operatorVerifier : independentVerifier),
        index + 1
      );
      addResolvedDeal(db, deal(index + 10, counterparty, otherParty, Wallet.createRandom().address, Wallet.createRandom().address), index + 10);
    }

    const card = aggregateReputation(db, target)!;
    expect(card.graph.independent_counterparty_share).to.be.greaterThan(0);
    expect(card.trust_tier).to.equal("reputation_bearing");
    expect(card.provenance).to.deep.equal({ operator_verified: 1, self_adjudicated: 4 });
    expect(card.provenance.operator_verified + card.provenance.self_adjudicated).to.equal(card.deals_settled);

    const safe = publicCard(card);
    expect(safe).not.to.have.property("settled_volume");
    expect(safe.graph).to.deep.equal(card.graph);
    expect(safe.provenance).to.deep.equal(card.provenance);
    expect(safe.trust_tier).to.equal(card.trust_tier);

    const schema = JSON.parse(readFileSync(resolve(process.cwd(), "schemas/reputation-card.schema.json"), "utf8"));
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    expect(ajv.validate(schema, safe), JSON.stringify(ajv.errors)).to.equal(true);
    db.close();
  });
});

describe("settled volume", function () {
  function aggregateDeals(deals: StoredDeal[]) {
    const db = openDatabase(":memory:");
    deals.forEach((storedDeal, index) => addResolvedDeal(db, storedDeal, index + 1));
    const card = aggregateReputation(db, deals[0].buyer)!;
    db.close();
    return card;
  }

  function volumeDeal(id: number, tokenDecimals: number | null, token = TOKEN): StoredDeal {
    return {
      ...deal(
        id,
        "0x0000000000000000000000000000000000000011",
        "0x0000000000000000000000000000000000000012",
        "0x0000000000000000000000000000000000000013",
        "0x0000000000000000000000000000000000000014"
      ),
      token,
      token_decimals: tokenDecimals
    };
  }

  it("omits volume when one of two same-token deals has unknown decimals", function () {
    const card = aggregateDeals([volumeDeal(1, 2), volumeDeal(2, null)]);
    expect(card).not.to.have.property("settled_volume");
  });

  it("sums two same-token deals when both decimals are known", function () {
    const card = aggregateDeals([volumeDeal(1, 2), volumeDeal(2, 2)]);
    expect(card.settled_volume).to.deep.equal({ amount: "200", token: TOKEN, human: "2.0" });
  });

  it("omits volume when the only settled deal has unknown decimals", function () {
    const card = aggregateDeals([volumeDeal(1, null)]);
    expect(card).not.to.have.property("settled_volume");
  });

  it("omits volume for different tokens when one has unknown decimals", function () {
    const card = aggregateDeals([volumeDeal(1, 2), volumeDeal(2, null, OTHER_TOKEN)]);
    expect(card).not.to.have.property("settled_volume");
  });
});
