/**
 * Register a wallet as an agent on an ERC-8004 Identity Registry.
 *
 * The party that will be rated has to hold its own registration: if an operator
 * registered it on the party's behalf, the operator would be the owner and the
 * spec forbids feedback from an owner. So this runs with the party's own key,
 * separate from the publisher's key and from the service.
 *
 *   ERC8004_RPC_URL=… REGISTRANT_PRIVATE_KEY=… \
 *     npx ts-node scripts/register-erc8004.ts \
 *       --registry ethereum-sepolia --name "Some agent" \
 *       [--description "…"] [--key-var SELLER_PRIVATE_KEY] [--confirm]
 *
 * Two transactions: `register(agentURI)` mints the agentId, then `setAgentURI`
 * rewrites the file so its `registrations` entry names that id, which is what
 * this repository's reader checks for. The file is an inline data: URI, so
 * nothing has to be hosted. Without `--confirm` it prints the plan and the
 * wallet balance and writes nothing.
 */
import "dotenv/config";
import { Contract, Signer, Wallet, formatEther, getAddress } from "ethers";
import { getRegistry, makeProvider } from "../src/registries";

const REGISTER_ABI = [
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)"
];

export interface RegistrationText {
  name: string;
  description: string;
}

/** The registration file, ERC-8004 registration-v1, inline. */
export function registrationUri(chainId: number, registry: string, text: RegistrationText, agentId?: string): string {
  const file: Record<string, unknown> = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: text.name,
    description: text.description,
    active: true,
    services: []
  };
  if (agentId !== undefined) {
    file.registrations = [{ agentId: Number(agentId), agentRegistry: `eip155:${chainId}:${getAddress(registry)}` }];
  }
  return `data:application/json;base64,${Buffer.from(JSON.stringify(file), "utf8").toString("base64")}`;
}

/** Mint the agent, then point its URI at a file that names the minted id. Returns the agentId. */
export async function registerAgent(signer: Signer, chainId: number, registry: string, text: RegistrationText): Promise<string> {
  const contract = new Contract(registry, REGISTER_ABI, signer);
  const receipt = await (await contract.register(registrationUri(chainId, registry, text))).wait();
  const registered = receipt.logs
    .map((log: { topics: ReadonlyArray<string>; data: string }) => { try { return contract.interface.parseLog(log); } catch { return null; } })
    .find((parsed: { name: string } | null) => parsed?.name === "Registered");
  if (!registered) throw new Error("register() confirmed but emitted no Registered event");
  const agentId = String(registered.args.agentId);
  await (await contract.setAgentURI(agentId, registrationUri(chainId, registry, text, agentId))).wait();
  return agentId;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const registryName = flag("registry");
  const name = flag("name");
  if (!registryName || !name) throw new Error("--registry and --name are required");
  const text = { name, description: flag("description") ?? "" };
  const keyVar = flag("key-var") ?? "REGISTRANT_PRIVATE_KEY";
  const key = process.env[keyVar];
  if (!key) throw new Error(`${keyVar} is not set; this is the key of the wallet being registered`);
  const registry = getRegistry(registryName);
  const signer = new Wallet(key, makeProvider(registry));
  const balance = await signer.provider!.getBalance(signer.address);
  console.log(JSON.stringify({
    registry: registry.name, identityRegistry: registry.identityRegistry, wallet: signer.address,
    balance: `${formatEther(balance)} ETH`, file: registrationUri(registry.chainId, registry.identityRegistry, text),
    confirm: process.argv.includes("--confirm")
  }, null, 2));
  if (!process.argv.includes("--confirm")) { console.log("dry run; add --confirm to send two transactions"); return; }
  const agentId = await registerAgent(signer, registry.chainId, registry.identityRegistry, text);
  console.log(JSON.stringify({ agentId, owner: signer.address }));
}

if (require.main === module) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
