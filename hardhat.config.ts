// Tests drive lossy providers on purpose; spacing the re-asks would only slow them.
process.env.LOG_EMPTY_RETRY_DELAY_MS ??= "0";
import "@nomicfoundation/hardhat-toolbox";
import { HardhatUserConfig } from "hardhat/config";

const config: HardhatUserConfig = {
  solidity: {
    compilers: [{ version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 } } }],
    overrides: {
      // V04's DealOpened carries 17 fields, which is stack-too-deep on 0.8.20
      // however the emit is factored. viaIR clears it, but turning it on
      // globally would change the bytecode of every other contract here,
      // including MockERC8004, which the publisher tests deploy. Scoped to
      // the one file that needs it so nothing else moves.
      "contracts/mocks/MockEscrowV04.sol": {
        version: "0.8.20",
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true }
      }
    }
  },
  networks: { hardhat: {} },
  typechain: { outDir: "typechain-types", target: "ethers-v6" }
};

export default config;
