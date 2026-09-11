import { expect } from "chai";
import { Wallet } from "ethers";
import { isOperatorAddress, loadOperatorConfig } from "../src/operators";

describe("operator configuration", function () {
  const names = ["OPERATOR_VERIFIER_ADDRESSES", "OPERATOR_ARBITER_ADDRESSES"] as const;
  const previous = new Map<string, string | undefined>();

  beforeEach(function () {
    for (const name of names) {
      previous.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(function () {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("uses empty operator lists when both environment variables are unset", function () {
    const config = loadOperatorConfig();
    expect(config).to.deep.equal({ verifierAddresses: [], arbiterAddresses: [] });
    expect(isOperatorAddress(config, Wallet.createRandom().address)).to.equal(false);
  });

  it("parses comma-separated checksummed addresses and matches case-insensitively", function () {
    const verifier = Wallet.createRandom().address;
    const arbiter = Wallet.createRandom().address;
    process.env.OPERATOR_VERIFIER_ADDRESSES = `  ${verifier}, ${arbiter}  `;
    process.env.OPERATOR_ARBITER_ADDRESSES = ` ${arbiter} `;

    const config = loadOperatorConfig();
    expect(config.verifierAddresses).to.deep.equal([verifier, arbiter]);
    expect(config.arbiterAddresses).to.deep.equal([arbiter]);
    expect(isOperatorAddress(config, verifier.toLowerCase())).to.equal(true);
    expect(isOperatorAddress(config, arbiter.toLowerCase())).to.equal(true);
    expect(isOperatorAddress(config, Wallet.createRandom().address)).to.equal(false);
  });

  it("throws instead of silently dropping a malformed address", function () {
    process.env.OPERATOR_VERIFIER_ADDRESSES = "0x0000000000000000000000000000000000000001, not-an-address";
    expect(() => loadOperatorConfig()).to.throw("Invalid address in OPERATOR_VERIFIER_ADDRESSES:  not-an-address");
  });
});
