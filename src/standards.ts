/**
 * The standards surface: stable URIs other people's software resolves.
 *
 * Everything here exists because some external consumer needs a URL that keeps
 * working — a JSON Schema `$id`, an A2A extension URI on a seller's agent card,
 * an ERC-8004 `feedbackURI` written into a public event log. Those are promises
 * with different retraction costs, and the on-chain one cannot be retracted at
 * all, so the URIs are declared once here rather than assembled at each call
 * site where a typo would only surface after publication.
 *
 * The Sinetti design brief states the principle these routes serve: "interoperability
 * over invention", and §16 names the layer — Sinetti does not restate what
 * ERC-8004 or A2A already say, it supplies the record they point at.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express, { Express } from "express";
import { getAddress } from "ethers";
import { aggregateReputation, publicCard, ReputationCard, resolveDeal } from "./aggregator";
import { KNOWN_REGISTRIES } from "./registries";
import { DeploymentConfig, deployments } from "./config";
import { SinettiDatabase } from "./db";

/**
 * Where this deployment believes it is reachable from the public internet.
 *
 * Not cosmetic. It is baked into the A2A extension URI a seller copies onto
 * their agent card and into the `feedbackURI` written to an ERC-8004 event, so
 * a wrong value here is a dangling pointer in someone else's data, not ours.
 * The default is the production host because an operator who forgets to set it
 * should emit the right URI, not a localhost one.
 */
export function publicBaseUrl(): string {
  const configured = process.env.PUBLIC_BASE_URL ?? "https://rep.sinetti.ai";
  return configured.endsWith("/") ? configured.slice(0, -1) : configured;
}

/**
 * The A2A extension URI. Versioned in the path, never in a query parameter,
 * because A2A matches extensions by exact URI string: a v2 with different
 * params must be a different URI or clients silently mis-parse it.
 */
export const A2A_EXTENSION_PATH = "/ext/sinetti-recourse/v1";

export function a2aExtensionUri(): string {
  return `${publicBaseUrl()}${A2A_EXTENSION_PATH}`;
}

export const CARD_SCHEMA_PATH = "/schemas/reputation-card.schema.json";
export const EXTENSION_SCHEMA_PATH = "/schemas/a2a-recourse-extension.schema.json";

/** The public, machine-readable card an external verifier should re-read. */
export function cardUri(address: string): string {
  return `${publicBaseUrl()}/agents/${getAddress(address)}`;
}

function schemaFile(name: string): string {
  return readFileSync(resolve(process.cwd(), "schemas", name), "utf8");
}

/** CAIP-10, so an escrow reference is unambiguous across chains. */
export function caip10(deployment: DeploymentConfig): string {
  return `eip155:${deployment.chainId}:${getAddress(deployment.contract)}`;
}

/**
 * The escrow deployments whose settled events produced the indexed cards.
 *
 * `local` is excluded: it is a test fixture, and naming it in a published
 * artifact would advertise a chain nobody else can reach.
 */
export function publishedDeployments(): DeploymentConfig[] {
  return deployments.filter((deployment) => deployment.name !== "local");
}

export interface RecourseExtensionParams {
  wallet: string;
  card: string;
  cardSchema: string;
  escrows: string[];
  observed: {
    trustTier: ReputationCard["trust_tier"];
    dealsSettled: number;
    asOf: string;
  } | null;
}

export interface AgentExtension {
  uri: string;
  description: string;
  required: boolean;
  params: RecourseExtensionParams;
}

/**
 * Build the `capabilities.extensions[]` entry a seller pastes onto its A2A card.
 *
 * `required` is false, always. A2A defines `required: true` as "the client must
 * understand and comply with this extension", which would make a Sinetti-unaware
 * buyer refuse the seller outright. The whole point of the extension is that it
 * is a discoverable advantage to buyers who check, not a barrier to those who
 * do not.
 *
 * `observed` is a hint copied onto a document the seller controls, so it is
 * self-asserted by the time a buyer reads it and can be stale or forged. `card`
 * is the authoritative reading, and the description says so in the artifact
 * itself rather than only in our documentation, because the buyer's agent will
 * read the card and not our docs.
 */
export function buildRecourseExtension(
  db: SinettiDatabase,
  address: string,
  now: Date
): AgentExtension {
  const wallet = getAddress(address);
  // publicCard rather than the raw aggregate: this object is served
  // unauthenticated and copied onto a document the seller controls, so it
  // must not be able to leak a field the public card withholds.
  const record = aggregateReputation(db, wallet);
  const card = record ? publicCard(record) : null;
  return {
    uri: a2aExtensionUri(),
    description:
      "This agent settles through Sinetti escrow: funds are held non-custodially, "
      + "released against recorded acceptance criteria, and disputes go to Sinetti "
      + "recourse. The params below are self-asserted; fetch params.card for the "
      + "authoritative, operator-computed record.",
    required: false,
    params: {
      wallet,
      card: cardUri(wallet),
      cardSchema: `${publicBaseUrl()}${CARD_SCHEMA_PATH}`,
      escrows: publishedDeployments().map(caip10),
      observed: card
        ? {
          trustTier: card.trust_tier,
          dealsSettled: card.deals_settled,
          asOf: now.toISOString()
        }
        : null
    }
  };
}

/**
 * The document served at the extension URI itself.
 *
 * A2A does not require an extension URI to resolve. Serving one anyway is the
 * difference between a buyer's operator being able to find out what the
 * extension means and having to ask us.
 */
export function extensionDescriptor(): Record<string, unknown> {
  return {
    uri: a2aExtensionUri(),
    name: "Sinetti recourse",
    version: "1",
    status: "draft",
    specification: `${publicBaseUrl()}${A2A_EXTENSION_PATH}/spec.md`,
    paramsSchema: `${publicBaseUrl()}${EXTENSION_SCHEMA_PATH}`,
    summary:
      "Declares that an A2A agent trades under Sinetti escrow and recourse, and "
      + "points at its operator-computed reputation card.",
    trustModel:
      "Agent-card params are self-asserted by the agent that publishes the card. "
      + "A buyer MUST fetch params.card and compare params.wallet before relying "
      + "on any value here. Card contents are derived from public on-chain "
      + "settlement events and are not self-reported.",
    // No vocabulary field: V02 is deleted and every published deployment is
    // V04, so advertising it would publish a constant. If a second escrow
    // vocabulary ever ships, this is where a reader learns which one it is.
    escrows: publishedDeployments().map((deployment) => ({
      name: deployment.name,
      caip10: caip10(deployment)
    }))
  };
}

/** Hash of the exact bytes an external party will fetch, for ERC-8004 feedbackHash. */
export function cardContentHash(card: unknown): string {
  return `0x${createHash("sha256").update(JSON.stringify(card)).digest("hex")}`;
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

  router.get(CARD_SCHEMA_PATH, (_request, response) => {
    response.setHeader("Cache-Control", immutable);
    response.type("application/schema+json").send(schemaFile("reputation-card.schema.json"));
  });

  router.get(EXTENSION_SCHEMA_PATH, (_request, response) => {
    response.setHeader("Cache-Control", immutable);
    response.type("application/schema+json").send(schemaFile("a2a-recourse-extension.schema.json"));
  });

  router.get(SETTLEMENT_SCHEMA_PATH, (_request, response) => {
    response.setHeader("Cache-Control", immutable);
    response.type("application/schema+json").send(schemaFile("settlement-feedback.schema.json"));
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

  router.get(A2A_EXTENSION_PATH, (_request, response) => {
    response.setHeader("Cache-Control", immutable);
    response.json(extensionDescriptor());
  });

  // The descriptor points here, so it has to exist. An extension URI that
  // resolves to a JSON blob referencing a 404 is worse than one that does not
  // resolve at all: it looks specified.
  router.get(`${A2A_EXTENSION_PATH}/spec.md`, (_request, response) => {
    response.setHeader("Cache-Control", immutable);
    response.type("text/markdown; charset=utf-8")
      .send(readFileSync(resolve(process.cwd(), "docs/standards/a2a-recourse-extension.md"), "utf8"));
  });

  /**
   * The extension entry for one wallet, ready to paste into an agent card.
   *
   * Anonymous and unauthenticated on purpose: it composes only the thin card,
   * which is already public, plus URIs. A seller must be able to build its own
   * card entry without holding a Sinetti session, and a buyer must be able to
   * regenerate the entry to compare it against what the seller published.
   */
  router.get(`${A2A_EXTENSION_PATH}/for/:address`, (request, response) => {
    let wallet: string;
    try {
      wallet = getAddress(request.params.address);
    } catch {
      response.status(400).json({ error: "invalid_address" });
      return;
    }
    response.setHeader("Cache-Control", "public, max-age=60");
    response.json(buildRecourseExtension(db, wallet, new Date()));
  });

  app.use(router);
}
