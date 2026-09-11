import { expect } from "chai";
import { resolveHost } from "../src/index";

describe("server configuration", function () {
  it("defaults HOST to loopback", function () {
    expect(resolveHost({})).to.equal("127.0.0.1");
  });

  it("uses an explicitly configured HOST", function () {
    expect(resolveHost({ HOST: "100.64.0.10" })).to.equal("100.64.0.10");
  });
});
