import "dotenv/config";
import { AppExtension, createApp } from "./api";
import { getDeployment } from "./config";
import { openDatabase } from "./db";
import { indexDeployment, watchDeployment } from "./indexer";
import { checkFeedbackFiles, indexRegistryFeedback, recheckFeedback } from "./feedback";
import { checkAgentFiles, indexRegistryIdentity } from "./identity";
import { getRegistry } from "./registries";

/**
 * A hosted instance may ship `src/private.ts` exporting `extend`, which mounts routes on
 * top of the public reader. The public repository has no such file, and the reader runs
 * without one.
 */
function loadExtension(): AppExtension | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require("./private") as { extend?: AppExtension }).extend;
  } catch (error) {
    if ((error as { code?: string }).code === "MODULE_NOT_FOUND") return undefined;
    throw error;
  }
}

export function resolveHost(env: NodeJS.ProcessEnv): string {
  return env.HOST ?? "127.0.0.1";
}

async function main(): Promise<void> {
  const [command, deploymentName = "sepolia", ...flags] = process.argv.slice(2);
  if (
    (command === "api" || command === "index") &&
    process.env.NODE_ENV === "production" &&
    (process.env.RPC_DEPLOYMENT ?? "local") === "local"
  ) {
    throw new Error("Refusing to start in production with RPC_DEPLOYMENT=local: the service would serve cards indexed from localhost");
  }
  const db = openDatabase();
  if (command === "index") {
    const deployment = getDeployment(deploymentName);
    if (flags.includes("--watch")) await watchDeployment(db, deployment);
    else console.log(JSON.stringify(await indexDeployment(db, deployment)));
    return;
  }
  if (command === "feedback") {
    // Read an ERC-8004 registry: record its feedback events, then fetch and
    // verify each entry's file. Watch mode repeats on the escrow poll interval.
    const registry = getRegistry(deploymentName);
    const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 15_000);
    // Files are checked in bounded batches between index passes, so a flood of
    // entries pointing at slow hosts delays verification without stopping
    // indexing. Serial fetches at ten seconds each: 200 is at most ~33 minutes.
    const batch = Number(process.env.CHECK_BATCH ?? 200);
    if (flags.includes("--recheck")) console.log(JSON.stringify({ recheck: recheckFeedback(db, registry) }));
    for (;;) {
      const indexed = await indexRegistryFeedback(db, registry);
      const checked = await checkFeedbackFiles(db, registry, { limit: batch });
      console.log(JSON.stringify({ ...indexed, checked }));
      if (!flags.includes("--watch") && checked < batch) return;
      if (checked < batch) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  if (command === "identity") {
    // Read an ERC-8004 identity registry: record registrations, then fetch
    // each agent's registration file and agent card. Eight agents in flight,
    // two fetches each at ten seconds: a batch of 400 is at most ~17 minutes.
    const registry = getRegistry(deploymentName);
    const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 15_000);
    const batch = Number(process.env.CHECK_BATCH ?? 400);
    for (;;) {
      const indexed = await indexRegistryIdentity(db, registry);
      const checked = await checkAgentFiles(db, registry, { limit: batch });
      console.log(JSON.stringify({ ...indexed, checked }));
      if (!flags.includes("--watch") && checked < batch) return;
      if (checked < batch) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  if (command === "api") {
    const port = Number(process.env.PORT ?? 3000);
    // Defaults to loopback-only. HOST is an explicit opt-in for previewing over a private
    // network (a tailscale interface address, say). Never set it to 0.0.0.0 in production.
    const host = resolveHost(process.env);
    createApp(db, loadExtension()).listen(port, host, () => console.log(`Sinetti reputation API listening on http://${host}:${port}`));
    return;
  }
  throw new Error("Usage: npm run index -- <deployment> [--watch] | npm run feedback -- <registry> [--watch] [--recheck] | npm run identity -- <registry> [--watch] | npm run api");
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
