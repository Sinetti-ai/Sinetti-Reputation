/**
 * The standards surface: stable URIs other people's software resolves.
 *
 * Everything here exists because some external consumer needs a URL that keeps
 * working: a JSON Schema `$id`, an A2A extension URI on a seller's agent card,
 * an ERC-8004 `feedbackURI` written into a public event log. Those are promises
 * with different retraction costs, and the on-chain one cannot be retracted at
 * all, so the URIs are declared once here rather than assembled at each call
 * site where a typo would only surface after publication.
 *
 * The Sinetti design brief states the principle these routes serve: "interoperability
 * over invention", and §16 names the layer. Sinetti supplies the record that
 * ERC-8004 and A2A point at and restates nothing they already say.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express, { Express } from "express";
import { getAddress } from "ethers";
import { resolveDeal } from "./settlement";
import { KNOWN_REGISTRIES } from "./registries";
import { SinettiDatabase } from "./db";

/**
 * Where this deployment believes it is reachable from the public internet.
 *
 * Not cosmetic. It is baked into the A2A extension URI a seller copies onto
 * their agent card and into the `feedbackURI` written to an ERC-8004 event, so
 * a wrong value here is a dangling pointer in someone else's data.
 * The default is the production host so that an operator who forgets to set it
 * still emits a URI that resolves.
 */
export function publicBaseUrl(): string {
  const configured = process.env.PUBLIC_BASE_URL ?? "https://rep.sinetti.ai";
  return configured.endsWith("/") ? configured.slice(0, -1) : configured;
}

/**
 * Where a hosted instance serves the wallet card for an address. The public reader does
 * not serve that route; the URL is part of the published feedback document, so it is
 * fixed here and must not change once anything has been published against it.
 */
export function cardUri(address: string): string {
  return `${publicBaseUrl()}/agents/${getAddress(address)}`;
}

// The repository root, whether this runs from src/ under ts-node or from dist/.
const ROOT = resolve(__dirname, "..");

function schemaFile(name: string): string {
  return readFileSync(resolve(ROOT, "schemas", name), "utf8");
}

export const FEEDBACK_PATH = "/feedback";
export const SETTLEMENT_SCHEMA_PATH = "/schemas/settlement-feedback.schema.json";

/** Everything a settlement feedback document is derived from. All of it is in the URI. */
export interface SettlementFeedbackReference {
  registryChainId: number;
  registry: string;
  agentId: string;
  client: string;
  chainId: number;
  contract: string;
  dealId: string;
}

const AGENT_ID = /^[0-9]{1,78}$/;
const DEAL_ID = /^[0-9]{1,78}$/;
const CAIP10 = /^eip155:([0-9]{1,10}):(0x[0-9a-fA-F]{40})$/;

/** Parse route parameters into a reference, or null if any of them is malformed. */
export function parseSettlementFeedbackReference(params: Record<string, string>): SettlementFeedbackReference | null {
  const registry = params.registry?.match(CAIP10);
  const escrow = params.escrow?.match(CAIP10);
  if (!registry || !escrow || !AGENT_ID.test(params.agentId ?? "") || !DEAL_ID.test(params.dealId ?? "")) return null;
  let client: string;
  try {
    client = getAddress(params.client ?? "");
  } catch {
    return null;
  }
  return {
    registryChainId: Number(registry[1]),
    registry: getAddress(registry[2]),
    agentId: params.agentId,
    client,
    chainId: Number(escrow[1]),
    contract: getAddress(escrow[2]),
    dealId: params.dealId
  };
}

/**
 * The URI an ERC-8004 entry published by Sinetti points at. Every input to the
 * document is in the path, so the bytes are the same for every reader and can
 * be pinned by `feedbackHash`.
 */
export function settlementFeedbackUri(reference: SettlementFeedbackReference): string {
  return `${publicBaseUrl()}${FEEDBACK_PATH}`
    + `/eip155:${reference.registryChainId}:${getAddress(reference.registry)}`
    + `/${reference.agentId}/${getAddress(reference.client)}`
    + `/eip155:${reference.chainId}:${getAddress(reference.contract)}/${reference.dealId}`;
}

/**
 * The feedback document for one settled deal, or null if the deal is not
 * indexed or has not settled. Field names follow the ERC-8004 feedback file
 * (agentRegistry, agentId, clientAddress, createdAt, value, valueDecimals,
 * tag1, tag2) plus `settlement`, the claim the reader verifies.
 *
 * The seller is the subject, so `value` is 100 when the seller was paid and 0
 * otherwise, matching the publisher. `createdAt` is the settlement time from
 * chain, never the clock, so the document does not change between runs.
 *
 * Two fields come from this instance's configuration rather than the path:
 * `agentRegistry` (the identity registry paired with the reputation registry
 * in KNOWN_REGISTRIES; omitted when the pair is not known) and the two URLs
 * under PUBLIC_BASE_URL. Changing either after publishing changes these bytes
 * and every pinned hash stops matching. Treat both as frozen once anything
 * has been published against them.
 *
 * `clientAddress` is taken from the path and is not checked against anything:
 * the reader re-derives the parties from chain data and ignores this field,
 * and a document naming a rater who never rated is a claim nobody verifies.
 */
export function settlementFeedbackDocument(db: SinettiDatabase, reference: SettlementFeedbackReference): Record<string, unknown> | null {
  const resolved = resolveDeal(db, reference.chainId, reference.contract, reference.dealId);
  if (!resolved) return null;
  const known = Object.values(KNOWN_REGISTRIES)
    .find((candidate) => candidate.chainId === reference.registryChainId && candidate.reputationRegistry === getAddress(reference.registry));
  const escrow = `eip155:${reference.chainId}:${getAddress(reference.contract)}`;
  return {
    ...(known ? { agentRegistry: `eip155:${reference.registryChainId}:${known.identityRegistry}` } : {}),
    agentId: reference.agentId,
    clientAddress: getAddress(reference.client),
    createdAt: new Date(resolved.settledAt * 1_000).toISOString(),
    value: resolved.resolution === "release" ? 100 : 0,
    valueDecimals: 0,
    tag1: resolved.resolution,
    tag2: escrow,
    settlement: { chainId: reference.chainId, contract: getAddress(reference.contract), dealId: reference.dealId },
    subject: getAddress(resolved.deal.seller),
    card: cardUri(resolved.deal.seller),
    schema: `${publicBaseUrl()}${SETTLEMENT_SCHEMA_PATH}`
  };
}

export function registerStandardsRoutes(app: Express, db: SinettiDatabase): void {
  const router = express.Router();

  // Served with a long max-age: these are the URIs other people's data points
  // at, and they are versioned in the path, so a cached copy is never wrong.
  const immutable = "public, max-age=3600";

  router.get(SETTLEMENT_SCHEMA_PATH, (_request, response) => {
    response.setHeader("Cache-Control", immutable);
    response.type("application/schema+json").send(settlementSchema);
  });

  // The document an ERC-8004 entry points at. Served as the exact bytes the
  // publisher hashed: JSON.stringify of the same object, no pretty-printing.
  router.get(`${FEEDBACK_PATH}/:registry/:agentId/:client/:escrow/:dealId`, (request, response) => {
    const reference = parseSettlementFeedbackReference(request.params as Record<string, string>);
    if (!reference) {
      response.status(400).json({ error: "invalid_reference" });
      return;
    }
    const document = settlementFeedbackDocument(db, reference);
    if (!document) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    response.setHeader("Cache-Control", immutable);
    response.type("application/json").send(Buffer.from(JSON.stringify(document), "utf8"));
  });
  // The agent-readable summary, served from the repository root so the file a GitHub
  // visitor reads and the one an agent fetches are one document.
  const settlementSchema = schemaFile("settlement-feedback.schema.json");
  const llms = readFileSync(resolve(ROOT, "llms.txt"), "utf8");
  router.get("/llms.txt", (_request, response) => {
    response.type("text/plain; charset=utf-8").send(llms);
  });

  app.use(router);
}
