import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import express, { NextFunction, Request, Response } from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress } from "ethers";
import { aggregateReputation, listIndexedAddresses, publicCard } from "./aggregator";
import { SinettiDatabase } from "./db";
import { countMissingFeedback, listVerifiedAgents } from "./feedback";
import { agentCard, countMissingAgents, listAgentDirectory, searchAgents } from "./identity";
import { KNOWN_REGISTRIES, registryCaip10 } from "./registries";
import { loadOperatorConfig } from "./operators";
import { registerStandardsRoutes } from "./standards";
import { registerWebRoutes } from "./web";

const schema = JSON.parse(readFileSync(resolve(process.cwd(), "schemas/reputation-card.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validateCard = ajv.compile(schema);

function logPrivateError(context: string, error: unknown): void {
  console.error(`[${context}]`, error);
}

/**
 * The reputation API is read-only and unauthenticated by design.
 *
 * Every figure it serves is derived from public chain events, so the same card
 * is recomputable by anyone running this indexer against the same deployment.
 * An endpoint that required a session would gate data that is public anyway,
 * and a private table behind it would be an input no other reader holds —
 * which is what would stop the card being reproducible.
 */
export function createApp(db: SinettiDatabase) {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.json());
  app.use((_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  // The operator lists are the one input to a card that is not on chain; they
  // decide only the `provenance` split. Publishing them here is what lets a
  // reader reproduce that field too.
  app.get("/health", (_request, response) => {
    const operators = loadOperatorConfig();
    response.json({ status: "ok", operators: { verifier: operators.verifierAddresses, arbiter: operators.arbiterAddresses } });
  });

  app.get("/agents", (_request, response) => {
    response.json({ agents: listIndexedAddresses(db) });
  });

  app.get("/agents/:address", (request, response) => {
    let address: string;
    try {
      address = getAddress(request.params.address);
    } catch {
      response.status(400).json({ error: "invalid_address" });
      return;
    }
    const card = aggregateReputation(db, address);
    if (!card) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    const body = publicCard(card);
    if (!validateCard(body)) {
      response.status(500).json({ error: "invalid_card", details: validateCard.errors });
      return;
    }
    response.json(body);
  });

  // ERC-8004 read side. A card here is about an agentId on one registry: how
  // many feedback entries exist, how many carry a verifiable settlement claim,
  // and the score of those alone. Registry names are the keys of KNOWN_REGISTRIES.
  // `missing` is what the index should hold and does not: agent ids and feedback entries
  // sitting in a hole of their sequence. Non-zero means a scan is short (docs/derivation.md).
  app.get("/registries", (_request, response) => {
    response.json({
      registries: Object.values(KNOWN_REGISTRIES).map((registry) => {
        const config = { ...registry, rpcUrl: "", confirmations: 0 };
        return {
          name: registry.name, chain_id: registry.chainId, reputation_registry: registryCaip10(registry),
          missing: { agents: countMissingAgents(db, config), feedback: countMissingFeedback(db, config) }
        };
      })
    });
  });

  function registryFor(name: string) {
    // Card reads need no RPC: the registry is identified, never called.
    const known = Object.hasOwn(KNOWN_REGISTRIES, name) ? KNOWN_REGISTRIES[name] : undefined;
    return known ? { ...known, rpcUrl: "", confirmations: 0 } : null;
  }

  app.get("/registries/:name/agents", (request, response) => {
    const registry = registryFor(request.params.name);
    if (!registry) {
      response.status(404).json({ error: "unknown_registry" });
      return;
    }
    response.json({ registry: registryCaip10(registry), agents: listVerifiedAgents(db, registry) });
  });

  // The directory: every agent registered on the identity registry, with the
  // name it declares. Paged, most verified first.
  app.get("/registries/:name/directory", (request, response) => {
    const registry = registryFor(request.params.name);
    if (!registry) {
      response.status(404).json({ error: "unknown_registry" });
      return;
    }
    const page = typeof request.query.page === "string" && /^[1-9][0-9]{0,5}$/.test(request.query.page) ? Number(request.query.page) : 1;
    response.json({ registry: registryCaip10(registry), ...listAgentDirectory(db, registry, page) });
  });

  // Declared names are neither unique nor checked, so a search returns a list.
  app.get("/registries/:name/search", (request, response) => {
    const registry = registryFor(request.params.name);
    if (!registry) {
      response.status(404).json({ error: "unknown_registry" });
      return;
    }
    const query = typeof request.query.q === "string" ? request.query.q.trim().slice(0, 120) : "";
    if (!query) {
      response.status(400).json({ error: "missing_query" });
      return;
    }
    response.json({ registry: registryCaip10(registry), query, agents: searchAgents(db, registry, query) });
  });

  app.get("/registries/:name/agents/:agentId", (request, response) => {
    const registry = registryFor(request.params.name);
    if (!registry) {
      response.status(404).json({ error: "unknown_registry" });
      return;
    }
    if (!/^[0-9]{1,78}$/.test(request.params.agentId)) {
      response.status(400).json({ error: "invalid_agent_id" });
      return;
    }
    const card = agentCard(db, registry, request.params.agentId);
    if (!card) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    response.json(card);
  });

  registerStandardsRoutes(app, db);
  registerWebRoutes(app, db);

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status
      : 500;
    if (status >= 500) logPrivateError("api", error);
    response.status(status).json({ error: status === 400 ? "invalid_json" : "request_failed" });
  });

  return app;
}
