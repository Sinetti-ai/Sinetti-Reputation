import { expect } from "chai";
import { Log, Provider } from "ethers";
import { HOLE_COOLDOWN_MS, forgetHoles, getLogsRetryingEmpty, holeOnCooldown, sequenceHoles, topicOf } from "../src/logs";

function providerAnswering(answers: Log[][]): { provider: Provider; calls: () => number } {
  let calls = 0;
  const provider = {
    getLogs: async () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      return answer;
    }
  } as unknown as Provider;
  return { provider, calls: () => calls };
}

describe("getLogsRetryingEmpty", () => {
  const log = { blockNumber: 1 } as unknown as Log;
  const filter = { address: "0x0", fromBlock: 1, toBlock: 2 };

  it("re-asks when the RPC answers a populated window with an empty list", async () => {
    const { provider, calls } = providerAnswering([[], [log]]);
    expect(await getLogsRetryingEmpty(provider, filter)).to.deep.equal([log]);
    expect(calls()).to.equal(2);
  });

  it("accepts an empty window after the attempt budget", async () => {
    const { provider, calls } = providerAnswering([[]]);
    expect(await getLogsRetryingEmpty(provider, filter)).to.deep.equal([]);
    expect(calls()).to.equal(5);
  });

  it("does not re-ask a populated answer", async () => {
    const { provider, calls } = providerAnswering([[log]]);
    await getLogsRetryingEmpty(provider, filter);
    expect(calls()).to.equal(1);
  });
});

describe("sequenceHoles", () => {
  it("bounds each hole by its neighbours' blocks and the scan start", () => {
    const known = [{ position: 2, block: 20 }, { position: 3, block: 30 }, { position: 7, block: 70 }];
    expect(sequenceHoles(known, 1, 5)).to.deep.equal([
      { from: 1, to: 1, fromBlock: 5, toBlock: 20 },
      { from: 4, to: 6, fromBlock: 30, toBlock: 70 }
    ]);
  });

  it("sees no hole in a contiguous run and none after the last known position", () => {
    expect(sequenceHoles([{ position: 1, block: 1 }, { position: 2, block: 2 }], 1, 0)).to.deep.equal([]);
    expect(sequenceHoles([], 1, 0)).to.deep.equal([]);
  });
});

describe("topicOf", () => {
  it("pads a uint256 and an address to 32 bytes", () => {
    expect(topicOf(4039n)).to.equal(`0x${"0".repeat(60)}0fc7`);
    expect(topicOf("0xA0AA0Cad68c0BB41479AA2fa61EeDC88F1D9C5d7")).to.equal(`0x${"0".repeat(24)}a0aa0cad68c0bb41479aa2fa61eedc88f1d9c5d7`);
  });
});

describe("holeOnCooldown", () => {
  beforeEach(forgetHoles);

  it("lets a hole through once, then holds it for the cooldown", () => {
    expect(holeOnCooldown("r:id:1-3", 1_000)).to.equal(false);
    expect(holeOnCooldown("r:id:1-3", 1_000 + HOLE_COOLDOWN_MS - 1)).to.equal(true);
    expect(holeOnCooldown("r:id:1-3", 1_000 + HOLE_COOLDOWN_MS)).to.equal(false);
  });
});
