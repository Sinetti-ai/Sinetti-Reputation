/**
 * Publish settled Sinetti outcomes to an ERC-8004 Reputation Registry.
 *
 * A separate entry point from `src/index.ts` on purpose. The indexer and the
 * API accept no private key; this is the only thing in the project that does,
 * and keeping it out of the service binary means an operator cannot start the
 * API with a funded key in the environment by accident.
 *
 *   ERC8004_RPC_URL=… ERC8004_PRIVATE_KEY=… \
 *     npx ts-node scripts/publish-erc8004.ts \
 *       --registry ethereum-sepolia \
 *       --agent-ids 0xSELLER=42 \
 *       [--subject 0xSELLER] [--limit 1] [--key-var BUYER_PRIVATE_KEY] [--confirm]
 *
 * Without `--confirm` it prints the plan and writes nothing. Every write is
 * permanent, public, and paid for; ERC-8004 has no edit, only `revokeFeedback`
 * by the original client, so the dry run is the review step.
 */
import "dotenv/config";
import { openDatabase } from "../src/db";
import {
  checkAgentId, getRegistry, listPendingPublications, loadSigner, makeProvider, parseAgentIds,
  planPublication, publish
} from "../src/publisher";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const registryName = flag("registry");
  if (!registryName) throw new Error("--registry is required (e.g. --registry ethereum-sepolia)");
  const rawAgentIds = flag("agent-ids") ?? process.env.ERC8004_AGENT_IDS;
  if (!rawAgentIds) {
    throw new Error(
      "--agent-ids is required, as 0xADDRESS=AGENTID[,…]. ERC-8004 has no reverse index from "
      + "wallet to agentId, so the mapping must be supplied and is verified against the "
      + "Identity Registry before anything is written."
    );
  }

  const registry = getRegistry(registryName);
  const agentIds = parseAgentIds(rawAgentIds);
  const limit = flag("limit") ? Number(flag("limit")) : undefined;
  // The signer's address is part of every feedback document (ERC-8004's
  // clientAddress), so planning needs the key present even for a dry run.
  // Nothing is sent without --confirm.
  // --key-var names the environment variable holding the rater's key (default ERC8004_PRIVATE_KEY).
  const signer = loadSigner(registry, flag("key-var") ?? "ERC8004_PRIVATE_KEY");
  const db = openDatabase();

  try {
    const pending = listPendingPublications(db, registry);
    if (pending.length > 0) {
      console.log(`${pending.length} pending publication(s) never recorded a receipt. Check each on chain, then`);
      console.log("either set tx_hash and published_at on the row or delete it. Nothing is sent while they exist.");
      for (const row of pending) {
        console.log(`  deal ${row.deployment}/${row.dealId}  subject ${row.subject}  agentId ${row.agentId}  tx ${row.txHash ?? "not broadcast"}`);
      }
      return;
    }
    const plans = planPublication(db, registry, agentIds, signer.address, { subject: flag("subject"), limit });
    if (plans.length === 0) {
      console.log("Nothing to publish: no settled deal is both unpublished and covered by --agent-ids.");
      return;
    }

    console.log(`Plan: ${plans.length} feedback write(s) to ${registry.reputationRegistry} on chain ${registry.chainId}:`);
    for (const plan of plans) {
      console.log(
        `  deal ${plan.deployment}/${plan.dealId}  subject ${plan.subject}  agentId ${plan.agentId}  `
        + `value ${plan.value}  tag1 ${plan.tag1}  uri ${plan.feedbackURI}`
      );
    }

    if (!process.argv.includes("--confirm")) {
      // Verified read-only so the operator sees binding failures before paying
      // for them, and before deciding whether to confirm at all.
      const provider = makeProvider(registry);
      for (const plan of plans) {
        const check = await checkAgentId(provider, registry, plan.agentId, plan.subject, signer.address);
        const verdict = !check.matchesSubject ? "UNBOUND, would refuse"
          : check.publisherIsOwner ? "SELF-FEEDBACK, would refuse"
            : "ok";
        console.log(`  check agentId ${plan.agentId}: wallet=${check.wallet ?? "unset"} owner=${check.owner ?? "unset"} → ${verdict}`);
      }
      console.log("\nDry run. Re-run with --confirm to send. Writes are permanent and cannot be edited.");
      return;
    }

    const results = await publish(db, registry, signer, plans);
    for (const result of results) {
      console.log(`published deal ${result.plan.deployment}/${result.plan.dealId} → ${result.txHash}`);
    }
  } finally {
    db.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
