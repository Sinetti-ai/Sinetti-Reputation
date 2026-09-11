/**
 * ERC-8004 registries: where they are, and the read surface this service uses.
 *
 * Kept apart from `publisher.ts` so the reader (indexer, API, web) can know about
 * registries without importing the publisher, which is the one module that
 * holds a signing key. A test asserts that separation over the import graph.
 *
 * ## What is read, and what is never trusted
 *
 * The Reputation Registry stores five fields per entry (`value`,
 * `valueDecimals`, `tag1`, `tag2`, `isRevoked`) and emits, without storing,
 * the pointer to the rater's feedback file (`feedbackURI`, `feedbackHash`).
 * `giveFeedback` is permissionless: any address may rate any agent, and the
 * published scores are known to be sybil-flooded (arXiv 2606.26028, covering
 * deployments through 2026-05-13, finds coordinated sybil behaviour in 73.5% of
 * reviewers on Ethereum, 59.2% on BSC and 90.6% on Base).
 *
 * So this service reads every feedback *event* as a claim, fetches the file it
 * points at, and counts the entry only when the rater can prove something an
 * outsider can check: today, that the rater was a counterparty in a settled
 * escrow deal with the agent. The registry's own summary functions are never
 * called: `REPUTATION_REGISTRY_EVENTS_ABI` holds events only, and the
 * publisher's write ABI holds one function. Neither can return a score.
 */
import { JsonRpcProvider, Contract, Provider, getAddress } from "ethers";
import { confirmationDepth } from "./config";

export interface RegistryConfig {
  name: string;
  chainId: number;
  reputationRegistry: string;
  identityRegistry: string;
  rpcUrl: string;
  /** Block the reputation registry was created in; nothing is scanned below it. */
  fromBlock: number;
  /** Block the identity registry was created in. Deployed first, so at or below `fromBlock`. */
  identityFromBlock: number;
  /** Lowest agentId the registry mints. The reference contract post-increments from 0. */
  firstAgentId?: number;
  confirmations: number;
}

/** The events the reader indexes. Events only: nothing here returns a value. */
export const REPUTATION_REGISTRY_EVENTS_ABI = [
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex)"
] as const;

/**
 * Identity-registry reads. They answer *who* an agentId is, never how good
 * anyone is, and both the publisher and the reader need that answer.
 */
export const IDENTITY_REGISTRY_ABI = [
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)"
] as const;

/**
 * The identity events the directory indexes: an agent appears with its
 * registration URI, and may move that URI later. `MetadataSet` is not read;
 * nothing indexed so far uses on-chain metadata for anything a card shows.
 */
export const IDENTITY_REGISTRY_EVENTS_ABI = [
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  "event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)"
] as const;

type KnownRegistry = Omit<RegistryConfig, "rpcUrl" | "confirmations">;

/**
 * The reference deployments from github.com/erc-8004/erc-8004-contracts.
 *
 * Verified on 2026-09-10 by `eth_getCode` at each address and by calling
 * `getIdentityRegistry()` on each reputation registry, which returned the
 * identity address listed beside it. Creation blocks are from the creation
 * transaction Blockscout records for each proxy. Base mainnet's proxy exposes
 * no creation transaction there; its block is the Ethereum mainnet creation
 * date mapped onto Base's two-second blocks with a wide margin below, so the
 * first scan over Base reads some empty history rather than missing entries.
 * Identity registries were deployed one to two blocks before their reputation
 * registry on every chain with a creation record; Base's identity block is
 * the same estimate moved an hour further down.
 *
 * The addresses are CREATE2 vanity deployments, identical across chains, but
 * "identical address" is not "deployed": every chain here was probed.
 */
export const KNOWN_REGISTRIES: Record<string, KnownRegistry> = {
  "ethereum-sepolia": {
    name: "ethereum-sepolia",
    chainId: 11155111,
    reputationRegistry: getAddress("0x8004B663056A597Dffe9eCcC1965A193B7388713"),
    identityRegistry: getAddress("0x8004A818BFB912233c491871b3d84c89A494BD9e"),
    fromBlock: 9989394,
    identityFromBlock: 9989393
  },
  "base-sepolia": {
    name: "base-sepolia",
    chainId: 84532,
    reputationRegistry: getAddress("0x8004B663056A597Dffe9eCcC1965A193B7388713"),
    identityRegistry: getAddress("0x8004A818BFB912233c491871b3d84c89A494BD9e"),
    fromBlock: 36304146,
    identityFromBlock: 36304145
  },
  ethereum: {
    name: "ethereum",
    chainId: 1,
    reputationRegistry: getAddress("0x8004BAa17C55a88189AE136b182e5fdA19dE9b63"),
    identityRegistry: getAddress("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"),
    fromBlock: 24339873,
    identityFromBlock: 24339871
  },
  base: {
    name: "base",
    chainId: 8453,
    reputationRegistry: getAddress("0x8004BAa17C55a88189AE136b182e5fdA19dE9b63"),
    identityRegistry: getAddress("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"),
    fromBlock: 41246350,
    identityFromBlock: 41242750
  }
};

/** `ERC8004_RPC_URL_ETHEREUM_SEPOLIA`, falling back to `ERC8004_RPC_URL`. */
export function registryRpcUrl(name: string): string {
  const specific = process.env[`ERC8004_RPC_URL_${name.toUpperCase().replaceAll("-", "_")}`];
  return specific ?? process.env.ERC8004_RPC_URL ?? "";
}

export function getRegistry(name: string): RegistryConfig {
  const known = KNOWN_REGISTRIES[name];
  if (!known) {
    throw new Error(`Unknown ERC-8004 registry: ${name}. Known: ${Object.keys(KNOWN_REGISTRIES).join(", ")}`);
  }
  const rpcUrl = registryRpcUrl(name);
  if (!rpcUrl) throw new Error(`No RPC URL for registry ${name}: set ERC8004_RPC_URL_${name.toUpperCase().replaceAll("-", "_")} or ERC8004_RPC_URL`);
  return { ...known, rpcUrl, confirmations: confirmationDepth() };
}

/** CAIP-10 of a reputation registry, the stable name a card carries for it. */
export function registryCaip10(registry: Pick<RegistryConfig, "chainId" | "reputationRegistry">): string {
  return `eip155:${registry.chainId}:${getAddress(registry.reputationRegistry)}`;
}

export function makeProvider(registry: RegistryConfig): JsonRpcProvider {
  return new JsonRpcProvider(registry.rpcUrl, registry.chainId, { staticNetwork: true });
}

export interface AgentBinding {
  wallet: string | null;
  owner: string | null;
}

/**
 * Whether `operator` may act for the agent's token: the owner itself, the address
 * approved for that token, or an operator approved for all of the owner's tokens.
 * ERC-8004 forbids feedback from any of them. A revert reads as "not approved".
 */
export async function isAgentOperator(provider: Provider, registry: RegistryConfig, agentId: string, owner: string | null, operator: string): Promise<boolean> {
  if (!owner) return false;
  const who = getAddress(operator);
  if (owner === who) return true;
  const identity = new Contract(registry.identityRegistry, IDENTITY_REGISTRY_ABI, provider);
  const approved = await identity.getApproved(agentId).then(getAddress).catch(() => null);
  if (approved === who) return true;
  return identity.isApprovedForAll(owner, who).then(Boolean).catch(() => false);
}

/**
 * The addresses an agentId is bound to: its declared payment wallet, and the
 * owner of its ERC-721 token. A revert on either (unset wallet, unminted id)
 * is reported as null rather than thrown, because "no binding" is the answer.
 */
export async function resolveAgentBinding(provider: Provider, registry: RegistryConfig, agentId: string): Promise<AgentBinding> {
  const identity = new Contract(registry.identityRegistry, IDENTITY_REGISTRY_ABI, provider);
  const wallet = await identity.getAgentWallet(agentId).then(getAddress).catch(() => null);
  const owner = await identity.ownerOf(agentId).then(getAddress).catch(() => null);
  return { wallet, owner };
}
