import express, { NextFunction, Request, Response } from "express";
import { getAddress } from "ethers";
import { SinettiDatabase } from "./db";
import { countMissingFeedback, listVerifiedAgents } from "./feedback";
import { agentCard, countMissingAgents, listAgentDirectory, searchAgents } from "./identity";
import { KNOWN_REGISTRIES, registryCaip10 } from "./registries";
import { registerStandardsRoutes } from "./standards";

function logPrivateError(context: string, error: unknown): void {
  console.error(`[${context}]`, error);
}

/**
 * The reputation API is read-only and unauthenticated by design.
 *
 * Every figure it serves is derived from public chain events, so the same card
 * is recomputable by anyone running this indexer against the same deployment.
 * An endpoint that required a session would gate data that is public anyway,
 * and a private table behind it would be an input no other reader holds,
 * which is what would stop the card being reproducible.
 */
/**
 * `extend` lets a hosted instance mount routes on top of the public reader (a wallet card,
 * pages for people). It runs after the public routes and before the error handler, so an
 * extension cannot shadow a public route. The public reader itself needs no extension.
 */
export type AppExtension = (app: express.Express, db: SinettiDatabase) => void;

export function createApp(db: SinettiDatabase, extend?: AppExtension) {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  // ERC-8004 read side. A card here is about an agentId on one registry: how
  // many feedback entries exist, how many carry a verifiable settlement claim,
  // and the score of those alone. Registry names are the keys of KNOWN_REGISTRIES.
  // `missing` is what the index should hold and does not: agent ids and feedback entries
  // sitting in a hole of their sequence. Non-zero means a scan is short (docs/derivation.md).
  // Counting walks every id, so the answer is held for a minute; the route is public.
  let registriesCache: { at: number; body: unknown } | null = null;
  app.get("/registries", (_request, response) => {
    if (!registriesCache || Date.now() - registriesCache.at > 60_000) {
      registriesCache = {
        at: Date.now(),
        body: {
          registries: Object.values(KNOWN_REGISTRIES).map((registry) => {
            const config = { ...registry, rpcUrl: "", confirmations: 0 };
            return {
              name: registry.name, chain_id: registry.chainId, reputation_registry: registryCaip10(registry),
              missing: { agents: countMissingAgents(db, config), feedback: countMissingFeedback(db, config) }
            };
          })
        }
      };
    }
    response.json(registriesCache.body);
  });

  function pageOf(request: Request): number {
    return typeof request.query.page === "string" && /^[1-9][0-9]{0,5}$/.test(request.query.page) ? Number(request.query.page) : 1;
  }

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
    response.json({ registry: registryCaip10(registry), ...listVerifiedAgents(db, registry, pageOf(request)) });
  });

  // The directory: every agent registered on the identity registry, with the
  // name it declares. Paged, most verified first.
  app.get("/registries/:name/directory", (request, response) => {
    const registry = registryFor(request.params.name);
    if (!registry) {
      response.status(404).json({ error: "unknown_registry" });
      return;
    }
    response.json({ registry: registryCaip10(registry), ...listAgentDirectory(db, registry, pageOf(request)) });
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
  extend?.(app, db);

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status
      : 500;
    if (status >= 500) logPrivateError("api", error);
    response.status(status).json({ error: "request_failed" });
  });

  return app;
}
