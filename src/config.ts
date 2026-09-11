import "dotenv/config";
import { getAddress } from "ethers";

export interface DeploymentConfig {
  name: string;
  chainId: number;
  contract: string;
  rpcUrl: string;
  fromBlock: number;
  confirmations: number;
}

export function confirmationDepth(): number {
  const confirmations = Number(process.env.CONFIRMATIONS ?? 5);
  if (!Number.isSafeInteger(confirmations) || confirmations <= 0) {
    throw new Error(`CONFIRMATIONS must be a positive integer, got: ${confirmations}`);
  }
  return confirmations;
}

export const deployments: DeploymentConfig[] = [
  {
    name: "sepolia",
    chainId: 11155111,
    contract: getAddress("0x73862690E12621b3BC5749281CE4b23fe4a1695c"),
    rpcUrl: process.env.SEPOLIA_RPC_URL ?? "",
    // SinettiEscrowV04 v0.1.0 deploy block, from Sinetti-Escrow
    // deployments/sepolia.json (escrow.block). Every public receipt is above it.
    fromBlock: 11628623,
    confirmations: confirmationDepth()
  },
  {
    name: "local",
    chainId: 31337,
    contract: process.env.LOCAL_CONTRACT_ADDRESS ?? "0x0000000000000000000000000000000000000000",
    rpcUrl: process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:18546",
    fromBlock: 0,
    confirmations: confirmationDepth()
  }
];

export function getDeployment(name: string): DeploymentConfig {
  const deployment = deployments.find((candidate) => candidate.name === name);
  if (!deployment) throw new Error(`Unknown deployment: ${name}`);
  if (!deployment.rpcUrl) throw new Error(`Missing RPC URL for deployment: ${name}`);
  return deployment;
}

export function getConfiguredDeployment(): DeploymentConfig {
  return getDeployment(process.env.RPC_DEPLOYMENT ?? "local");
}
