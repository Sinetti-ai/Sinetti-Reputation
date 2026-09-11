import { expect } from "chai";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import request from "supertest";
import { encodeBytes32String, getAddress } from "ethers";
import { createApp } from "../src/api";
import { StoredDeal, openDatabase } from "../src/db";
import {
  A2A_EXTENSION_PATH, CARD_SCHEMA_PATH, EXTENSION_SCHEMA_PATH,
  a2aExtensionUri, publicBaseUrl, publishedDeployments
} from "../src/standards";

const TOKEN = "0x0000000000000000000000000000000000000001";
const SELLER = "0x00000000000000000000000000000000000000A1";
const BUYER = "0x00000000000000000000000000000000000000B2";
const OTHER = "0x00000000000000000000000000000000000000C3";
const UNKNOWN = "0x00000000000000000000000000000000000000dd";

function insertSettledDeal(db: ReturnType<typeof openDatabase>, dealId: string): void {
  const deal: StoredDeal = {
    deployment: "standards-test",
    chain_id: 31337,
    contract: TOKEN,
    deal_id: dealId,
    block_number: Number(dealId),
    buyer: BUYER,
    seller: SELLER,
    arbiter: OTHER,
    verifier: OTHER,
    token: TOKEN,
    token_decimals: 2,
    amount: "1000",
    bond: "0",
    criteria_hash: `0x${"00".repeat(32)}`,
    deadline: 2_000_000_000,
    funded_at: 1_700_000_000
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

describe("standards surface", function () {
  let db: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof createApp>;

  beforeEach(function () {
    db = openDatabase(":memory:");
    app = createApp(db);
  });

  afterEach(function () {
    db.close();
  });

  describe("schema hosting", function () {
    it("serves the reputation card schema at its own $id path", async function () {
      const response = await request(app).get(CARD_SCHEMA_PATH).expect(200);
      expect(response.headers["content-type"]).to.contain("application/schema+json");
      expect(response.body.$id).to.equal(`${publicBaseUrl()}${CARD_SCHEMA_PATH}`);
    });

    // The point of the whole task: a $id that does not resolve is a promise to
    // external validators that we do not keep, and the ERC-8004 feedbackURI
    // makes the same promise on-chain where it cannot be cheaply retracted.
    it("keeps the card schema $id equal to the path it is served from", function () {
      const onDisk = JSON.parse(readFileSync(resolve(process.cwd(), "schemas/reputation-card.schema.json"), "utf8"));
      expect(onDisk.$id).to.equal(`https://rep.sinetti.ai${CARD_SCHEMA_PATH}`);
      expect(onDisk.$id).to.not.contain(".example");
    });

    it("serves the extension params schema at its own $id path", async function () {
      const response = await request(app).get(EXTENSION_SCHEMA_PATH).expect(200);
      expect(response.body.$id).to.equal(`https://rep.sinetti.ai${EXTENSION_SCHEMA_PATH}`);
    });
  });

  describe("A2A extension", function () {
    it("resolves the extension URI to a descriptor naming its own URI", async function () {
      const response = await request(app).get(A2A_EXTENSION_PATH).expect(200);
      expect(response.body.uri).to.equal(a2aExtensionUri());
      expect(response.body.paramsSchema).to.equal(`${publicBaseUrl()}${EXTENSION_SCHEMA_PATH}`);
      expect(response.body.trustModel).to.contain("self-asserted");
    });

    it("names every published escrow deployment and excludes the local fixture", async function () {
      const response = await request(app).get(A2A_EXTENSION_PATH).expect(200);
      const names = response.body.escrows.map((escrow: { name: string }) => escrow.name);
      expect(names).to.not.contain("local");
      expect(names).to.deep.equal(publishedDeployments().map((deployment) => deployment.name));
      for (const escrow of response.body.escrows) {
        expect(escrow.caip10).to.match(/^eip155:[0-9]+:0x[0-9a-fA-F]{40}$/);
      }
    });

    it("builds a schema-valid extension entry for an indexed wallet", async function () {
      insertSettledDeal(db, "1");
      const response = await request(app).get(`${A2A_EXTENSION_PATH}/for/${SELLER}`).expect(200);

      const ajv = new Ajv2020({ allErrors: true });
      addFormats(ajv);
      const validate = ajv.compile(JSON.parse(
        readFileSync(resolve(process.cwd(), "schemas/a2a-recourse-extension.schema.json"), "utf8")
      ));
      expect(validate(response.body.params), JSON.stringify(validate.errors)).to.equal(true);

      expect(response.body.uri).to.equal(a2aExtensionUri());
      expect(response.body.params.card).to.equal(`${publicBaseUrl()}/agents/${response.body.params.wallet}`);
      expect(response.body.params.observed.dealsSettled).to.equal(1);
    });

    // A2A treats `required: true` as "refuse me if you do not implement this".
    // Setting it would make every Sinetti-unaware buyer walk away from a seller
    // whose only crime is carrying extra assurance.
    it("never marks the extension required", async function () {
      insertSettledDeal(db, "1");
      const response = await request(app).get(`${A2A_EXTENSION_PATH}/for/${SELLER}`).expect(200);
      expect(response.body.required).to.equal(false);
    });

    it("reports a wallet with no settled history as observed: null rather than zeroes", async function () {
      const response = await request(app).get(`${A2A_EXTENSION_PATH}/for/${UNKNOWN}`).expect(200);
      expect(response.body.params.observed).to.equal(null);
      expect(response.body.params.wallet).to.equal(getAddress(UNKNOWN));
    });

    // An example that drifts out of schema is worse than no example: it is the
    // thing an integrator copies.
    it("keeps the worked example card valid against the published params schema", function () {
      const card = JSON.parse(readFileSync(resolve(process.cwd(), "schemas/examples/a2a-agent-card.example.json"), "utf8"));
      const [extension] = card.capabilities.extensions;
      expect(extension.uri).to.equal("https://rep.sinetti.ai/ext/sinetti-recourse/v1");
      expect(extension.required).to.equal(false);

      const ajv = new Ajv2020({ allErrors: true });
      addFormats(ajv);
      const validate = ajv.compile(JSON.parse(
        readFileSync(resolve(process.cwd(), "schemas/a2a-recourse-extension.schema.json"), "utf8")
      ));
      expect(validate(extension.params), JSON.stringify(validate.errors)).to.equal(true);
    });

    it("resolves the spec URL its own descriptor points at", async function () {
      const descriptor = await request(app).get(A2A_EXTENSION_PATH).expect(200);
      const path = new URL(descriptor.body.specification).pathname;
      const spec = await request(app).get(path).expect(200);
      expect(spec.headers["content-type"]).to.contain("text/markdown");
      expect(spec.text).to.contain(a2aExtensionUri());
    });

    it("rejects a malformed address", async function () {
      await request(app).get(`${A2A_EXTENSION_PATH}/for/not-an-address`).expect(400);
    });

    // A seller must be able to build its own card entry, and a buyer must be
    // able to regenerate it for comparison, without holding a Sinetti session.
    it("serves the extension entry without authentication", async function () {
      insertSettledDeal(db, "1");
      const response = await request(app).get(`${A2A_EXTENSION_PATH}/for/${SELLER}`);
      expect(response.status).to.equal(200);
      expect(response.headers).to.not.have.property("www-authenticate");
    });
  });

  describe("PUBLIC_BASE_URL", function () {
    const original = process.env.PUBLIC_BASE_URL;

    afterEach(function () {
      if (original === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = original;
    });

    it("defaults to the production host so a forgetful operator still emits real URIs", function () {
      delete process.env.PUBLIC_BASE_URL;
      expect(publicBaseUrl()).to.equal("https://rep.sinetti.ai");
    });

    it("strips a trailing slash so composed URIs never double up", function () {
      process.env.PUBLIC_BASE_URL = "https://example.test/";
      expect(a2aExtensionUri()).to.equal(`https://example.test${A2A_EXTENSION_PATH}`);
    });
  });
});
