import { expect } from "chai";
import { Wallet } from "ethers";
import request from "supertest";
import { createApp } from "../src/api";
import { openDatabase } from "../src/db";

const TOKEN = "0x0000000000000000000000000000000000000001";
const CRITERIA = `0x${"00".repeat(32)}`;




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

  it("reports health without a database read", async function () {
    const response = await request(app).get("/health").expect(200);
    expect(response.body).to.deep.equal({ status: "ok" });
  });

  it("returns a client error for malformed JSON instead of crashing the request", async function () {
    const response = await request(app)
      .post("/agents")
      .set("Content-Type", "application/json")
      .send("{ not json");
    expect(response.status).to.be.oneOf([400, 404]);
  });

  it("serves no wallet card in the public reader, and an extension mounts after the public routes", async function () {
    await request(app).get("/agents").expect(404);
    await request(app).get(`/agents/${Wallet.createRandom().address}`).expect(404);
    const extended = createApp(db, (extendedApp) => {
      extendedApp.get("/agents", (_request, response) => { response.json({ mounted: true }); });
      extendedApp.get("/health", (_request, response) => { response.json({ shadowed: true }); });
    });
    expect((await request(extended).get("/agents").expect(200)).body).to.deep.equal({ mounted: true });
    expect((await request(extended).get("/health").expect(200)).body).to.deep.equal({ status: "ok" });
  });

  it("serves llms.txt from the repository root as plain text", async function () {
    const response = await request(app).get("/llms.txt").expect(200);
    expect(response.headers["content-type"]).to.include("text/plain");
    expect(response.text).to.include("# Sinetti Reputation");
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
