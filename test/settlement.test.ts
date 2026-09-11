import { expect } from "chai";
import { decodeBytes32String, encodeBytes32String } from "ethers";
import { DealEvent, classifyOutcome } from "../src/settlement";

const settled = (reason: string): DealEvent => ({
  event_name: "Settled",
  args: { reason: encodeBytes32String(reason) }
});
const opened = (): DealEvent => ({ event_name: "DealOpened", args: {} });
const verdictOf = (verdict: number): DealEvent => ({
  event_name: "VerificationRecorded",
  args: { verdict: String(verdict) }
});

// The outcome lives in `Settled.reason` rather than in which event fired. Nine
// reasons, eight of which decide release or refund on their own.
describe("outcome classification", function () {
  it("classifies an accepted delivery as a release", function () {
    expect(classifyOutcome([opened(), settled("accepted")])).to.equal("release");
  });

  it("classifies a passed verdict as a release", function () {
    expect(classifyOutcome([opened(), verdictOf(1), settled("verdict_pass")])).to.equal("release");
  });

  it("classifies a failed verdict as a refund", function () {
    expect(classifyOutcome([opened(), verdictOf(2), settled("verdict_fail")])).to.equal("refund");
  });

  it("classifies an inconclusive verdict as a refund, like a failure", function () {
    expect(classifyOutcome([opened(), verdictOf(3), settled("verdict_inconclusive")])).to.equal(
      "refund"
    );
  });

  it("classifies a timeout as a refund", function () {
    expect(classifyOutcome([opened(), settled("timeout")])).to.equal("refund");
  });

  it("slashes only on ruling_refund, and only when a bond was in custody", function () {
    expect(
      classifyOutcome([
        opened(),
        { event_name: "Challenged", args: {} },
        { event_name: "BondSlashed", args: {} },
        settled("ruling_refund")
      ])
    ).to.equal("refund_and_slash");
    // ruling_refund is the only slashing path, but a deal that never posted a
    // bond has nothing to slash and must not be reported as if it did.
    expect(classifyOutcome([opened(), settled("ruling_refund")])).to.equal("refund");
  });

  it("classifies an arbitrator ruling from the reason alone", function () {
    expect(classifyOutcome([opened(), settled("ruling_release")])).to.equal("release");
  });

  // The one reason that cannot decide itself: the arbitrator said nothing, so
  // the deal falls back to whatever the verifier had already recorded.
  it("resolves ruling_lapsed through the standing verdict", function () {
    expect(classifyOutcome([opened(), verdictOf(1), settled("ruling_lapsed")])).to.equal("release");
    expect(classifyOutcome([opened(), verdictOf(2), settled("ruling_lapsed")])).to.equal("refund");
    expect(classifyOutcome([opened(), verdictOf(3), settled("ruling_lapsed")])).to.equal("refund");
  });

  it("declines to score a mutual cancellation as either outcome", function () {
    // Terminal, but neither a release nor a refund. V02 had no such state, and
    // counting it as one would misreport both parties.
    //
    // The reason is checked before the outcome because an unrecognised reason is
    // also null: misspell `cancelled` and this passes while testing nothing that
    // has to do with cancellation. The eight positives above cannot cover that:
    // they protect the classifier, and this protects the input.
    const events = [opened(), settled("cancelled")];
    expect(decodeBytes32String(String(events[1].args.reason))).to.equal("cancelled");

    expect(classifyOutcome(events)).to.equal(null);
  });

  it("returns null for a deal that has not settled", function () {
    const events = [opened(), { event_name: "BondPosted", args: {} }];
    // Same reason: "unsettled" is what makes this null, so the fixture has to be
    // shown to actually lack a settlement rather than be assumed to.
    expect(events.some((event) => event.event_name === "Settled")).to.equal(false);

    expect(classifyOutcome(events)).to.equal(null);
  });
});

// The retired V02 contract used a different vocabulary whose state ordinals
// disagreed with V04's (its Refunded was V04's Released), so a stream read with
// the wrong constants inverted outcomes rather than failing to match. Support
// for it is gone, and with it the whole dual-classification path. What replaces
// the guard is upstream: the indexer refuses an address with no contract code,
// so a repoint at the retired deployment stops rather than indexing to zero.
describe("retired vocabulary", function () {
  // Both assertions below are `null`, which a classifier broken to return null
  // unconditionally would also satisfy. This pins that it still classifies.
  it("still classifies a V04 stream, so the nulls below mean something", function () {
    expect(classifyOutcome([opened(), settled("accepted")])).to.equal("release");
  });

  it("does not classify a V02 stream at all", function () {
    const v02Release: DealEvent[] = [
      { event_name: "AgreementFunded", args: {} },
      { event_name: "EscrowReleased", args: {} },
      { event_name: "AgreementClosed", args: { state: "4" } }
    ];
    expect(classifyOutcome(v02Release)).to.equal(null);
  });

  it("does not read a V02 state ordinal as a V04 outcome", function () {
    // V02's AgreementClosed(5) meant Refunded. Nothing here reads that ordinal
    // any more, so the deal is unclassifiable rather than silently inverted.
    const v02Refund: DealEvent[] = [
      { event_name: "EscrowRefunded", args: { reasonCode: encodeBytes32String("timeout") } },
      { event_name: "AgreementClosed", args: { state: "5" } }
    ];
    expect(classifyOutcome(v02Refund)).to.equal(null);
  });
});
