import { expect } from "chai";
import { Wallet, encodeBytes32String, getAddress, keccak256, toUtf8Bytes } from "ethers";
import { StoredDeal, openDatabase } from "../src/db";
import {
  Fetcher, MAX_FEEDBACK_FILE_BYTES, fetchFeedbackFile, isPrivateHost, readSettlementClaim, resolveFeedbackUri,
  verifySettlement
} from "../src/feedback";

const ZERO_HASH = `0x${"00".repeat(32)}`;
const ESCROW = "0x0000000000000000000000000000000000000E5C";
const TOKEN = "0x0000000000000000000000000000000000000001";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function fetcherReturning(status: number, body: string | Uint8Array): Fetcher {
  return async () => ({ status, body: typeof body === "string" ? bytes(body) : body });
}

describe("ERC-8004 feedback files", function () {
  describe("URI rules", function () {
    it("accepts https and ipfs, and refuses everything else", function () {
      expect(resolveFeedbackUri("https://example.com/f.json")).to.deep.equal({ url: "https://example.com/f.json" });
      expect(resolveFeedbackUri("ipfs://bafyabc/feedback.json")).to.deep.equal({ url: "https://ipfs.io/ipfs/bafyabc/feedback.json" });
      for (const uri of ["http://example.com/f.json", "file:///etc/passwd", "ftp://x/y", "data:text/html,{}", "not a uri"]) {
        expect(resolveFeedbackUri(uri), uri).to.deep.equal({ status: "scheme_refused" });
      }
    });

    it("refuses credentials in the URL and resolves ipfs paths without traversal", function () {
      expect(resolveFeedbackUri("https://user:pw@example.com/f.json")).to.deep.equal({ status: "scheme_refused" });
      // WHATWG URL parsing collapses the dot segments before we ever see them.
      expect(resolveFeedbackUri("ipfs://bafy/../x")).to.deep.equal({ url: "https://ipfs.io/ipfs/bafy/x" });
      const encoded = resolveFeedbackUri("ipfs://bafy/%2e%2e/x");
      expect("url" in encoded ? encoded.url.includes("..") : false).to.equal(false);
    });

    it("decodes inline data URIs without fetching, JSON media types only, and names an empty URI", function () {
      const plain = resolveFeedbackUri('data:application/json,{"name":"A%20B"}');
      expect("data" in plain ? new TextDecoder().decode(plain.data) : null).to.equal('{"name":"A B"}');
      const base64 = resolveFeedbackUri(`data:application/json;base64,${Buffer.from('{"x":1}').toString("base64")}`);
      expect("data" in base64 ? new TextDecoder().decode(base64.data) : null).to.equal('{"x":1}');
      expect("data" in resolveFeedbackUri('data:,{"bare":true}')).to.equal(true);
      expect(resolveFeedbackUri("data:text/html,<script>")).to.deep.equal({ status: "scheme_refused" });
      expect(resolveFeedbackUri("data:application/json;base64,%%%")).to.have.property("data");
      expect(resolveFeedbackUri("")).to.deep.equal({ status: "no_uri" });
      expect(resolveFeedbackUri("   ")).to.deep.equal({ status: "no_uri" });
    });

    it("refuses private and local hosts", function () {
      for (const host of ["localhost", "127.0.0.1", "10.1.2.3", "172.16.0.9", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "[::1]", "printer.local", "db.internal", "224.0.0.1",
        // A trailing root dot survives URL parsing on names and still resolves.
        "localhost.", "db.internal.", "fec0::1", "64:ff9b::7f00:1", "2002:7f00:1::", "198.18.0.1", "192.0.0.1"]) {
        expect(isPrivateHost(host), host).to.equal(true);
      }
      for (const host of ["example.com", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111"]) {
        expect(isPrivateHost(host), host).to.equal(false);
      }
      expect(resolveFeedbackUri("https://127.0.0.1/f.json")).to.deep.equal({ status: "private_host" });
      expect(resolveFeedbackUri("https://localhost./f.json")).to.deep.equal({ status: "private_host" });
      expect(resolveFeedbackUri("https://[::1]/f.json")).to.deep.equal({ status: "private_host" });
    });
  });

  describe("fetching", function () {
    it("returns the parsed object for a small, well-formed file with no pinned hash", async function () {
      const file = await fetchFeedbackFile("https://example.com/f.json", ZERO_HASH, fetcherReturning(200, '{"a":1}'));
      expect(file).to.deep.equal({ status: "ok", json: { a: 1 } });
    });

    it("accepts a file whose keccak matches the pinned hash and refuses one that does not", async function () {
      const body = '{"settlement":{}}';
      const hash = keccak256(toUtf8Bytes(body));
      expect((await fetchFeedbackFile("https://x.io/f", hash, fetcherReturning(200, body))).status).to.equal("ok");
      expect((await fetchFeedbackFile("https://x.io/f", hash, fetcherReturning(200, body + " "))).status).to.equal("hash_mismatch");
    });

    it("refuses oversize bodies, non-2xx responses, network failures and non-object JSON", async function () {
      const big = new Uint8Array(MAX_FEEDBACK_FILE_BYTES + 1);
      expect((await fetchFeedbackFile("https://x.io/f", ZERO_HASH, fetcherReturning(200, big))).status).to.equal("too_large");
      expect((await fetchFeedbackFile("https://x.io/f", ZERO_HASH, fetcherReturning(404, "{}"))).status).to.equal("unreachable");
      expect((await fetchFeedbackFile("https://x.io/f", ZERO_HASH, async () => { throw new Error("ECONNRESET"); })).status).to.equal("unreachable");
      expect((await fetchFeedbackFile("https://x.io/f", ZERO_HASH, fetcherReturning(200, "[1,2]"))).status).to.equal("invalid_json");
      expect((await fetchFeedbackFile("https://x.io/f", ZERO_HASH, fetcherReturning(200, "nope"))).status).to.equal("invalid_json");
      let calls = 0;
      const counting: Fetcher = async (url) => { calls += 1; return fetcherReturning(200, "{}")(url); };
      const inline = await fetchFeedbackFile('data:application/json,{"settlement":null}', ZERO_HASH, counting);
      expect(inline.status).to.equal("ok");
      expect(calls).to.equal(0);
      // The hash rule still applies to inline bytes.
      expect((await fetchFeedbackFile('data:application/json,{"a":1}', `0x${"11".repeat(32)}`, counting)).status).to.equal("hash_mismatch");
      // Parses iteratively, would overflow the stack when stored: refused as a status, never a crash.
      const deep = `{"a":${"[".repeat(20_000)}${"]".repeat(20_000)}}`;
      expect((await fetchFeedbackFile("https://x.io/f", ZERO_HASH, fetcherReturning(200, deep))).status).to.equal("invalid_json");
    });

    it("never calls the fetcher for a refused URI", async function () {
      let calls = 0;
      const spy: Fetcher = async () => { calls += 1; return { status: 200, body: bytes("{}") }; };
      await fetchFeedbackFile("http://example.com/f", ZERO_HASH, spy);
      await fetchFeedbackFile("https://10.0.0.1/f", ZERO_HASH, spy);
      expect(calls).to.equal(0);
    });
  });

  describe("settlement claims", function () {
    it("reads a well-formed claim and rejects malformed ones", function () {
      expect(readSettlementClaim({ settlement: { chainId: 11155111, contract: ESCROW.toLowerCase(), dealId: "6" } }))
        .to.deep.equal({ chainId: 11155111, contract: getAddress(ESCROW), dealId: "6" });
      for (const bad of [
        {}, { settlement: null }, { settlement: "x" },
        { settlement: { chainId: "1", contract: ESCROW, dealId: "6" } },
        { settlement: { chainId: 0, contract: ESCROW, dealId: "6" } },
        { settlement: { chainId: 1, contract: "0x123", dealId: "6" } },
        { settlement: { chainId: 1, contract: ESCROW, dealId: 6 } },
        { settlement: { chainId: 1, contract: ESCROW, dealId: "-6" } }
      ]) {
        expect(readSettlementClaim(bad), JSON.stringify(bad)).to.equal(null);
      }
    });
  });

  describe("verification against indexed deals", function () {
    let db: ReturnType<typeof openDatabase>;
    const buyer = Wallet.createRandom().address;
    const seller = Wallet.createRandom().address;
    const stranger = Wallet.createRandom().address;

    function insertDeal(dealId: string, settled: boolean, reason = "accepted"): void {
      const deal: StoredDeal = {
        deployment: "t", chain_id: 31337, contract: getAddress(ESCROW), deal_id: dealId, block_number: 1,
        buyer, seller, arbiter: stranger, verifier: stranger, token: TOKEN, token_decimals: 2, amount: "1", bond: "0",
        criteria_hash: `0x${"00".repeat(32)}`, deadline: 2_000_000_000, funded_at: 1_700_000_000
      };
      db.prepare(`INSERT INTO deals (deployment, chain_id, contract, deal_id, block_number, buyer, seller, arbiter, verifier, token,
        token_decimals, amount, bond, criteria_hash, deadline, funded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(deal.deployment, deal.chain_id, deal.contract, deal.deal_id, deal.block_number, deal.buyer, deal.seller, deal.arbiter,
          deal.verifier, deal.token, deal.token_decimals, deal.amount, deal.bond, deal.criteria_hash, deal.deadline, deal.funded_at);
      if (!settled) return;
      db.prepare(`INSERT INTO raw_events (deployment, chain_id, contract, tx_hash, log_index, block_number, block_timestamp, deal_id, event_name, args_json)
        VALUES (?, ?, ?, ?, 0, 2, 1700000100, ?, 'Settled', ?)`)
        .run(deal.deployment, deal.chain_id, deal.contract, `0x${dealId.padStart(64, "0")}`, dealId,
          JSON.stringify({ reason: encodeBytes32String(reason) }));
    }

    beforeEach(function () {
      db = openDatabase(":memory:");
    });
    afterEach(function () {
      db.close();
    });

    const claim = { chainId: 31337, contract: ESCROW, dealId: "1" };

    it("verifies the buyer rating the seller's agent, and the seller rating the buyer's", function () {
      insertDeal("1", true);
      const asBuyer = verifySettlement(db, claim, buyer, { wallet: seller, owner: null });
      expect(asBuyer).to.include({ clientRole: "buyer", agentAddress: seller, resolution: "release", dealId: "1", settledAt: 1_700_000_100 });
      const asSeller = verifySettlement(db, claim, seller, { wallet: null, owner: buyer });
      expect(asSeller).to.include({ clientRole: "seller", agentAddress: buyer });
    });

    it("rejects a rater who was not a party, an agent who was not the other party, and self-rating", function () {
      insertDeal("1", true);
      expect(verifySettlement(db, claim, stranger, { wallet: seller, owner: null })).to.equal(null);
      expect(verifySettlement(db, claim, buyer, { wallet: stranger, owner: stranger })).to.equal(null);
      expect(verifySettlement(db, claim, buyer, { wallet: buyer, owner: null })).to.equal(null);
      expect(verifySettlement(db, claim, buyer, { wallet: null, owner: null })).to.equal(null);
      // The owner declares a second wallet, deals with himself, rates from the
      // first address. Both sides of the deal are the agent; nothing verifies.
      expect(verifySettlement(db, claim, buyer, { wallet: seller, owner: buyer })).to.equal(null);
      expect(verifySettlement(db, claim, seller, { wallet: seller, owner: buyer })).to.equal(null);
    });

    it("rejects a deal with the same address on both sides", function () {
      const deal: StoredDeal = {
        deployment: "t", chain_id: 31337, contract: getAddress(ESCROW), deal_id: "7", block_number: 1,
        buyer, seller: buyer, arbiter: stranger, verifier: stranger, token: TOKEN, token_decimals: 2, amount: "1", bond: "0",
        criteria_hash: `0x${"00".repeat(32)}`, deadline: 2_000_000_000, funded_at: 1_700_000_000
      };
      db.prepare(`INSERT INTO deals (deployment, chain_id, contract, deal_id, block_number, buyer, seller, arbiter, verifier, token,
        token_decimals, amount, bond, criteria_hash, deadline, funded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(deal.deployment, deal.chain_id, deal.contract, deal.deal_id, deal.block_number, deal.buyer, deal.seller, deal.arbiter,
          deal.verifier, deal.token, deal.token_decimals, deal.amount, deal.bond, deal.criteria_hash, deal.deadline, deal.funded_at);
      db.prepare(`INSERT INTO raw_events (deployment, chain_id, contract, tx_hash, log_index, block_number, block_timestamp, deal_id, event_name, args_json)
        VALUES ('t', 31337, ?, ?, 0, 2, 1700000100, '7', 'Settled', ?)`)
        .run(getAddress(ESCROW), `0x${"7".padStart(64, "0")}`, JSON.stringify({ reason: encodeBytes32String("accepted") }));
      expect(verifySettlement(db, { ...claim, dealId: "7" }, buyer, { wallet: stranger, owner: null })).to.equal(null);
    });

    it("rejects a deal that is unknown, unsettled or cancelled", function () {
      expect(verifySettlement(db, claim, buyer, { wallet: seller, owner: null })).to.equal(null);
      insertDeal("1", false);
      expect(verifySettlement(db, claim, buyer, { wallet: seller, owner: null })).to.equal(null);
      insertDeal("2", true, "cancelled");
      expect(verifySettlement(db, { ...claim, dealId: "2" }, buyer, { wallet: seller, owner: null })).to.equal(null);
    });

    it("keys the deal by chain and contract, not id alone", function () {
      insertDeal("1", true);
      expect(verifySettlement(db, { ...claim, chainId: 1 }, buyer, { wallet: seller, owner: null })).to.equal(null);
      expect(verifySettlement(db, { ...claim, contract: TOKEN }, buyer, { wallet: seller, owner: null })).to.equal(null);
    });
  });
});
