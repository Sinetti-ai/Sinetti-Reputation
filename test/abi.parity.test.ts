import { expect } from "chai";
import { Interface } from "ethers";
import { artifacts } from "hardhat";
import { SINETTI_ESCROW_V04_ABI } from "../src/abi";

/**
 * The indexer decodes logs with `SINETTI_ESCROW_V04_ABI`, and every integration
 * test produces those logs from `MockEscrowV04`. If the two drift, the tests
 * keep passing against a fixture that no longer resembles what the real
 * deployment emits — the failure mode is silent, because a topic0 that matches
 * nothing is not fetched and "no events" reads the same as "nothing happened".
 *
 * This pins them to each other. It does NOT prove either matches
 * `contracts/SinettiEscrowV04.sol` in Sinetti-Escrow; that contract lives in another
 * package with a different compiler, and nothing in this repo currently checks
 * this ABI against it. Treat that as an open gap, not as covered here.
 */
describe("V04 ABI parity", function () {
  function signatures(iface: Interface): string[] {
    const found: string[] = [];
    iface.forEachEvent((event) => found.push(event.format("sighash")));
    return found.sort();
  }

  it("the mock emits exactly the events the indexer decodes, with identical arities", async function () {
    const mock = await artifacts.readArtifact("MockEscrowV04");
    const mockEvents = signatures(new Interface(mock.abi));
    const indexerEvents = signatures(new Interface(SINETTI_ESCROW_V04_ABI));

    expect(mockEvents).to.deep.equal(indexerEvents);
  });

  it("carries the seven events the deal projection and classifier read", async function () {
    const mock = await artifacts.readArtifact("MockEscrowV04");
    const names = signatures(new Interface(mock.abi)).map((signature) => signature.slice(0, signature.indexOf("(")));

    expect(names).to.have.members([
      "BondPosted",
      "BondSlashed",
      "Challenged",
      "DealOpened",
      "DealParties",
      "Settled",
      "VerificationRecorded"
    ]);
  });

  it("keeps DealOpened's identity anchors in the signature even though the mock writes zeros", async function () {
    // The four bytes32 anchors are the intended ERC-8004 / vLEI join point. They
    // are zero on the live deployment too, but they must stay in the event shape:
    // dropping them from the fixture would change topic0 and quietly stop the
    // indexer's filter from matching real DealOpened logs.
    const mock = await artifacts.readArtifact("MockEscrowV04");
    const dealOpened = new Interface(mock.abi).getEvent("DealOpened");

    const anchors = dealOpened!.inputs.filter((input) => input.name.endsWith("IdentityRef"));
    expect(anchors.map((input) => input.name)).to.deep.equal([
      "buyerIdentityRef",
      "sellerIdentityRef",
      "verifierIdentityRef",
      "arbitratorIdentityRef"
    ]);
    expect(anchors.every((input) => input.type === "bytes32")).to.equal(true);
  });
});
