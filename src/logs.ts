import { Log, Provider } from "ethers";

type LogFilter = Parameters<Provider["getLogs"]>[0];

/**
 * `eth_getLogs` on public RPCs (publicnode Sepolia, observed 2026-09-10) answers a populated
 * window with an empty list and no error about half the time, in runs of several calls. An
 * indexer that takes that at face value advances its checkpoint past real events. An empty
 * answer is re-asked, `delayMs` apart; the first populated answer wins; `attempts` empty
 * answers in a row are accepted as genuinely empty. Empty runs on publicnode last several
 * seconds, so the re-asks are spaced; a genuinely empty window costs about two seconds.
 */
export async function getLogsRetryingEmpty(
  provider: Provider,
  filter: LogFilter,
  attempts = Number(process.env.LOG_EMPTY_RETRIES ?? 5),
  delayMs = Number(process.env.LOG_EMPTY_RETRY_DELAY_MS ?? 400)
): Promise<Log[]> {
  let logs: Log[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    logs = await provider.getLogs(filter);
    if (logs.length > 0) break;
  }
  return logs;
}

/** Passes over a hole known to hold events before giving up on it. */
export const REPAIR_PASSES = 3;
/** Public RPCs cap a getLogs range (publicnode: 50,000 blocks); repair windows are sliced under it. */
export const REPAIR_SLICE_BLOCKS = 50_000;

/** getLogs over a window wider than an RPC accepts: sliced, each slice re-asked when empty. */
export async function getLogsSliced(
  provider: Provider,
  filter: LogFilter & { fromBlock: number; toBlock: number },
  sliceBlocks = REPAIR_SLICE_BLOCKS
): Promise<Log[]> {
  const logs: Log[] = [];
  for (let from = filter.fromBlock; from <= filter.toBlock; from += sliceBlocks) {
    const to = Math.min(from + sliceBlocks - 1, filter.toBlock);
    logs.push(...await getLogsRetryingEmpty(provider, { ...filter, fromBlock: from, toBlock: to }));
  }
  return logs;
}

/** A 32-byte topic for a uint256 or an address. */
export function topicOf(value: bigint | string): string {
  const hex = typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, "");
  return `0x${hex.padStart(64, "0").toLowerCase()}`;
}

/**
 * Split a sorted list of known sequence positions into the holes between them, each with the
 * block window that must contain the missing events. `startBlock` bounds a hole before the
 * first known position. Holes after the last known position are invisible.
 */
export function sequenceHoles(
  known: Array<{ position: number; block: number }>,
  first: number,
  startBlock: number
): Array<{ from: number; to: number; fromBlock: number; toBlock: number }> {
  const holes: Array<{ from: number; to: number; fromBlock: number; toBlock: number }> = [];
  let expected = first;
  let previousBlock = startBlock;
  for (const entry of known) {
    if (entry.position > expected) {
      holes.push({ from: expected, to: entry.position - 1, fromBlock: previousBlock, toBlock: entry.block });
    }
    expected = entry.position + 1;
    previousBlock = entry.block;
  }
  return holes;
}

/** Holes already re-asked this process, with when; a hole is left alone for `HOLE_COOLDOWN_MS` after a try. */
export const HOLE_COOLDOWN_MS = 60 * 60 * 1000;
const holeTried = new Map<string, number>();

/** True when this hole was re-asked within the cooldown, so a watch loop skips it this tick. */
export function holeOnCooldown(key: string, now = Date.now()): boolean {
  const last = holeTried.get(key);
  if (last !== undefined && now - last < HOLE_COOLDOWN_MS) return true;
  holeTried.set(key, now);
  return false;
}

/** Test hook. */
export function forgetHoles(): void {
  holeTried.clear();
}
