import { expect } from "chai";
import { encodeBytes32String, keccak256, toUtf8Bytes } from "ethers";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { StoredDeal, openDatabase } from "../src/db";
import { aggregateReputation } from "../src/aggregator";
import {
  ANCHOR_DOMAIN, ASSURANCE_LEVELS, AssuranceLevel, ZERO_ANCHOR,
  identityAnchor, isUnset, verifyAnchor
} from "../src/identityanchor";

interface Vector { note: string; assurance: AssuranceLevel; identity_ref: string; anchor: string }

/**
 * Shared vectors, so that any other implementation tests against the same
 * file. Two independent implementations of one hash derivation do not fail loudly when
 * they drift — they simply stop matching, and every verification quietly
 * answers "not this identity" forever.
 */
const VECTORS: { zero: string; vectors: Vector[] } = JSON.parse(
  readFileSync(resolve(process.cwd(), "docs/standards/identity-anchor.vectors.json"), "utf8")
);

const SUBJECT = "0x00000000000000000000000000000000000000A1";
const OTHER = "0x00000000000000000000000000000000000000B2";
const TOKEN = "0x0000000000000000000000000000000000000001";

function insertSettled(
  db: ReturnType<typeof openDatabase>,
  dealId: string,
  refs: { buyer_identity_ref?: string | null; seller_identity_ref?: string | null }
): void {
  const deal: StoredDeal = {
    deployment: "anchor-test",
    chain_id: 31337,
    contract: TOKEN,
    deal_id: dealId,
    block_number: Number(dealId),
    buyer: OTHER,
    seller: SUBJECT,
    arbiter: OTHER,
    verifier: OTHER,
    token: TOKEN,
    token_decimals: 2,
    amount: "1000",
    bond: "0",
    criteria_hash: `0x${"00".repeat(32)}`,
    deadline: 2_000_000_000,
    funded_at: 1_700_000_000 + Number(dealId),
    ...refs
  };
  db.prepare(`
    INSERT INTO deals (
      deployment, chain_id, contract, deal_id, block_number, buyer, seller, arbiter, verifier, token,
      token_decimals, amount, bond, criteria_hash, deadline, funded_at, buyer_identity_ref, seller_identity_ref
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    deal.deployment, deal.chain_id, deal.contract, deal.deal_id, deal.block_number,
    deal.buyer, deal.seller, deal.arbiter, deal.verifier, deal.token, deal.token_decimals,
    deal.amount, deal.bond, deal.criteria_hash, deal.deadline, deal.funded_at,
    deal.buyer_identity_ref ?? null, deal.seller_identity_ref ?? null
  );
  // V04 settles in one log; the reason carries the outcome.
  for (const [logIndex, event] of [
    [0, { name: "Settled", args: { reason: encodeBytes32String("accepted") } }]
  ] as const) {
    db.prepare(`
      INSERT INTO raw_events (
        deployment, chain_id, contract, tx_hash, log_index, block_number,
        block_timestamp, deal_id, event_name, args_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deal.deployment, deal.chain_id, deal.contract, `0x${dealId.padStart(64, "0")}`, logIndex,
      deal.block_number, deal.funded_at, dealId, event.name, JSON.stringify(event.args)
    );
  }
}

describe("identity anchor", function () {
  describe("derivation", function () {
    it("matches every shared vector", function () {
      expect(VECTORS.vectors).to.have.length.greaterThan(0);
      for (const vector of VECTORS.vectors) {
        expect(identityAnchor(vector.assurance, vector.identity_ref), vector.note)
          .to.equal(vector.anchor);
      }
    });

    it("agrees with the shared file on the zero anchor", function () {
      expect(ZERO_ANCHOR).to.equal(VECTORS.zero);
    });

    // Assurance is inside the hash so an anchor written at deal time records
    // what was proven then, and cannot be retroactively upgraded.
    it("gives a different anchor for every assurance level of one subject", function () {
      const anchors = ASSURANCE_LEVELS.map((level) => identityAnchor(level, "lei:5493001KJTIIGC8Y1R12"));
      expect(new Set(anchors).size).to.equal(ASSURANCE_LEVELS.length);
    });

    // Without the prefix an anchor is just "some 32 bytes" and could be taken
    // for a terms hash or an evidence hash by anything that handles both.
    it("domain-separates from an undomained hash of the same payload", function () {
      expect(ANCHOR_DOMAIN).to.equal("sinetti-identity-anchor:v1");
      const undomained = keccak256(toUtf8Bytes("proven:lei:5493001KJTIIGC8Y1R12"));
      expect(identityAnchor("proven", "lei:5493001KJTIIGC8Y1R12")).to.not.equal(undomained);
    });

    it("rejects an unknown assurance level and an empty ref", function () {
      expect(() => identityAnchor("verified" as AssuranceLevel, "lei:X")).to.throw(/unknown assurance/);
      expect(() => identityAnchor("proven", "")).to.throw(/must not be empty/);
    });
  });

  describe("verification", function () {
    it("recovers the level when the caller already has the right candidate", function () {
      const anchor = identityAnchor("proven-role", "lei:5493001KJTIIGC8Y1R12");
      expect(verifyAnchor(anchor, "lei:5493001KJTIIGC8Y1R12")).to.equal("proven-role");
    });

    it("returns null for the wrong candidate rather than a nearest match", function () {
      const anchor = identityAnchor("proven", "lei:5493001KJTIIGC8Y1R12");
      expect(verifyAnchor(anchor, "lei:529900T8BM49AURSDO55")).to.equal(null);
    });

    it("is case-insensitive on the anchor, since chains and SQLite disagree on hex case", function () {
      const anchor = identityAnchor("proven", "lei:5493001KJTIIGC8Y1R12");
      expect(verifyAnchor(anchor.toUpperCase().replace("0X", "0x"), "lei:5493001KJTIIGC8Y1R12")).to.equal("proven");
    });

    it("treats the zero anchor as no answer, never as level none", function () {
      expect(verifyAnchor(ZERO_ANCHOR, "lei:5493001KJTIIGC8Y1R12")).to.equal(null);
      expect(isUnset(ZERO_ANCHOR)).to.equal(true);
      expect(isUnset(null)).to.equal(true);
      expect(isUnset(identityAnchor("none", "lei:X"))).to.equal(false);
    });
  });

  describe("on the reputation card", function () {
    let db: ReturnType<typeof openDatabase>;

    beforeEach(function () { db = openDatabase(":memory:"); });
    afterEach(function () { db.close(); });

    // Today's chain, exactly: V04 reserves the slot and no deal has filled it.
    it("reports an unfilled slot as no anchors, not as a failed identity", function () {
      insertSettled(db, "1", { seller_identity_ref: ZERO_ANCHOR, buyer_identity_ref: ZERO_ANCHOR });
      const card = aggregateReputation(db, SUBJECT)!;
      expect(card.identity_anchor).to.deep.equal({
        anchors: [], deals_with_anchor: 0, deals_without_anchor: 1
      });
    });

    // V02 has no slot at all. Counting its deals as "without anchor" would
    // report a contract limitation as a party's missing identity.
    it("does not count a vocabulary with no slot against the subject", function () {
      insertSettled(db, "1", { seller_identity_ref: null, buyer_identity_ref: null });
      const card = aggregateReputation(db, SUBJECT)!;
      // The deal must have been counted, or "no anchors" is indistinguishable
      // from "no deals" — which is the exact confusion this field exists to
      // prevent.
      expect(card.deals_settled).to.equal(1);
      expect(card.identity_anchor).to.deep.equal({
        anchors: [], deals_with_anchor: 0, deals_without_anchor: 0
      });
    });

    it("surfaces a filled slot and verifies against the claimed identity", function () {
      const anchor = identityAnchor("proven", "lei:5493001KJTIIGC8Y1R12");
      insertSettled(db, "1", { seller_identity_ref: anchor });
      const card = aggregateReputation(db, SUBJECT)!;
      expect(card.identity_anchor.anchors).to.deep.equal([anchor.toLowerCase()]);
      expect(card.identity_anchor.deals_with_anchor).to.equal(1);
      expect(verifyAnchor(card.identity_anchor.anchors[0], "lei:5493001KJTIIGC8Y1R12")).to.equal("proven");
    });

    // Two identities behind one wallet is a fact a buyer should see, not one
    // the card should resolve by picking the most recent.
    it("reports every distinct anchor rather than choosing one", function () {
      const first = identityAnchor("proven", "lei:5493001KJTIIGC8Y1R12");
      const second = identityAnchor("proven", "lei:529900T8BM49AURSDO55");
      insertSettled(db, "1", { seller_identity_ref: first });
      insertSettled(db, "2", { seller_identity_ref: second });
      insertSettled(db, "3", { seller_identity_ref: first });
      const card = aggregateReputation(db, SUBJECT)!;
      expect(card.identity_anchor.anchors).to.deep.equal([first, second].map((a) => a.toLowerCase()).sort());
      expect(card.identity_anchor.deals_with_anchor).to.equal(3);
    });

    it("orders anchors deterministically so one history renders one card", function () {
      const first = identityAnchor("proven", "lei:5493001KJTIIGC8Y1R12");
      const second = identityAnchor("proven", "lei:529900T8BM49AURSDO55");
      insertSettled(db, "1", { seller_identity_ref: second });
      insertSettled(db, "2", { seller_identity_ref: first });
      const anchors = aggregateReputation(db, SUBJECT)!.identity_anchor.anchors;
      expect(anchors).to.deep.equal([...anchors].sort());
    });
  });
});
