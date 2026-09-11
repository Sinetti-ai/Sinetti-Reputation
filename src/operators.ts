import { getAddress } from "ethers";

export interface OperatorConfig {
  verifierAddresses: string[];
  arbiterAddresses: string[];
}

function parseAddressList(variable: string): string[] {
  const value = process.env[variable] ?? "";
  if (value.trim() === "") return [];

  return value.split(",").map((entry) => {
    const address = entry.trim();
    try {
      return getAddress(address);
    } catch {
      throw new Error(`Invalid address in ${variable}: ${entry}`);
    }
  });
}

export function loadOperatorConfig(): OperatorConfig {
  return {
    verifierAddresses: parseAddressList("OPERATOR_VERIFIER_ADDRESSES"),
    arbiterAddresses: parseAddressList("OPERATOR_ARBITER_ADDRESSES")
  };
}

export function isOperatorAddress(config: OperatorConfig, address: string): boolean {
  const normalized = address.toLowerCase();
  return [...config.verifierAddresses, ...config.arbiterAddresses].some(
    (operatorAddress) => operatorAddress.toLowerCase() === normalized
  );
}
