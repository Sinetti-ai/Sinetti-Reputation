import { expect } from "chai";
import { encodeBytes32String, getAddress, Wallet } from "ethers";
import { aggregateReputation } from "../src/aggregator";
import { StoredDeal, openDatabase } from "../src/db";

const TOKEN = "0x0000000000000000000000000000000000000001";
const CRITERIA = `0x${"00".repeat(32)}`;

function addResolvedDeal(
  db: ReturnType<typeof openDatabase>,
  id: number,
  buyer: string,
  seller: string,
  arbiter: string = buyer,
  verifier: string = buyer
): void {
  const deal: StoredDeal = {
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

  const txHash = `0x${id.toString(16).padStart(64, "0")}`;
  for (const [logIndex, eventName, args] of [
    [0, "Settled", { reason: encodeBytes32String("verdict_pass") }]
  ] as const) {
    db.prepare(`
      INSERT INTO raw_events (
        deployment, chain_id, contract, tx_hash, log_index, block_number,
        block_timestamp, deal_id, event_name, args_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deal.deployment, deal.chain_id, deal.contract, txHash, logIndex, id,
      deal.funded_at, deal.deal_id, eventName, JSON.stringify(args)
    );
  }
}

describe("counterparty independence", function () {
  it("counts repeat_counterparty by distinct deals, not by role occurrences within one deal", function () {
    const db = openDatabase(":memory:");
    const subject = Wallet.createRandom().address;
    const counterparty = Wallet.createRandom().address;
    addResolvedDeal(db, 1, subject, counterparty, counterparty, counterparty);

    const firstCard = aggregateReputation(db, subject)!;
    expect(firstCard.repeat_counterparty).to.equal(false);
    expect(firstCard.graph.distinct_counterparties).to.equal(1);

    addResolvedDeal(db, 2, subject, counterparty, counterparty, counterparty);
    expect(aggregateReputation(db, subject)!.repeat_counterparty).to.equal(true);
    db.close();
  });

  // Two wallets are two identities, always. The card is computed from chain data
  // alone so that any reader recomputes the same figures; a private table of
  // declared wallet links would be an input nobody else holds. An agent that
  // wants its wallets read as one entity publishes that on its own registration.
  it("treats every wallet as its own identity, with no operator-side merging", function () {
    const db = openDatabase(":memory:");
    const subject = Wallet.createRandom().address;
    const first = Wallet.createRandom().address;
    const second = Wallet.createRandom().address;
    addResolvedDeal(db, 1, subject, first);
    addResolvedDeal(db, 2, subject, second);

    const card = aggregateReputation(db, subject)!;
    expect(card.graph.distinct_counterparties).to.equal(2);
    expect(card.repeat_counterparty).to.equal(false);
    db.close();
  });

  it("recognizes a neighbor from an unrelated identity as independent", function () {
    const db = openDatabase(":memory:");
    const subject = Wallet.createRandom().address;
    const counterparty = Wallet.createRandom().address;
    const unrelated = Wallet.createRandom().address;
    addResolvedDeal(db, 1, subject, counterparty);
    addResolvedDeal(db, 2, counterparty, unrelated);

    expect(aggregateReputation(db, subject)!.graph.independent_counterparty_share).to.equal(1);
    db.close();
  });

});
