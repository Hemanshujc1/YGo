import {
  APP_NAME_HEADER,
  APP_VERSION_HEADER,
  AppIdentity,
  ErrorEnvelope,
  HealthResponse,
  type AppName,
  type AppVersion,
  type ErrorCode,
} from "@ygo/contracts";
import Fastify, { type FastifyError, type FastifyServerOptions } from "fastify";
import { bodyFields, serializerCompiler, validatorCompiler, type ZodTypeProvider } from "./zod";
import type { Database } from "./db";
import type { IdentityVerifier } from "./adapters/identity-verifier";
import type { Mailer } from "./adapters/mailer";
import type { PlaceFinder } from "./adapters/place-finder";
import type { Clock } from "./adapters/clock";
import type { VisitPhotoStorage } from "./adapters/visit-photos";
import { registerShopVisitRoutes } from "./routes/shop-visits";
import { registerFeedRoutes } from "./routes/feed";
import { registerPriceSimulatorRoutes } from "./routes/price-simulator";
import { registerRateCardRoutes } from "./routes/rate-cards";
import type { ProductImageStorage } from "./adapters/product-images";
import { registerAddressRoutes } from "./routes/addresses";
import { registerAuthRoutes } from "./routes/auth";
import { registerAdminRoutes } from "./routes/admin";
import { registerAreaRoutes } from "./routes/areas";
import { registerCategoryRoutes } from "./routes/categories";
import { registerMasterProductRoutes } from "./routes/master-products";
import { registerCatalogImportRoutes } from "./routes/catalog-import";
import { registerPackRoutes } from "./routes/packs";
import { registerPlaceRoutes } from "./routes/places";
import { registerProfileRoutes } from "./routes/profile";
import { registerShopRoutes } from "./routes/shops";
import { registerShopAgreementRoutes } from "./routes/shop-agreement";
import { registerShopHolidayRoutes } from "./routes/shop-holidays";
import { registerShopHoursRoutes } from "./routes/shop-hours";
import { registerShopOpenRoutes } from "./routes/shop-open";
import { registerShopListingRoutes } from "./routes/shop-listings";

export interface AppOptions {
  /** Resolves when the database answers; rejects otherwise. */
  checkDatabase: () => Promise<void>;
  database?: Database;
  mailer?: Mailer;
  identityVerifier?: IdentityVerifier;
  clock?: Clock;
  authTokenSecret?: string;
  adminCookieDomain?: string;
  productImages?: ProductImageStorage;
  visitPhotos?: VisitPhotoStorage;
  /** C15's place search (#257); without it the search answers UNAVAILABLE. */
  places?: PlaceFinder;
  /** The oldest version of each app still served (Q-7); older ones are told to update. */
  minAppVersions?: Record<AppName, AppVersion>;
  logger?: FastifyServerOptions["logger"];
}

const envelope = (code: ErrorCode, fields?: string[]): ErrorEnvelope => ({
  error: fields ? { code, fields } : { code },
});

/** Whether `version` comes before `min`, comparing major, minor and patch as numbers. */
function isOlder(version: AppVersion, min: AppVersion): boolean {
  const minParts = min.split(".").map(Number);
  for (const [i, part] of version.split(".").map(Number).entries()) {
    const minPart = minParts[i] ?? 0;
    if (part !== minPart) return part < minPart;
  }
  return false;
}

export function buildApp({
  checkDatabase,
  database,
  mailer,
  identityVerifier,
  clock,
  authTokenSecret,
  adminCookieDomain,
  productImages,
  visitPhotos,
  places,
  minAppVersions = { customer: "0.0.0", shopkeeper: "0.0.0" },
  logger = false,
}: AppOptions) {
  const app = Fastify({ logger, trustProxy: "127.0.0.1" }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status =
      typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : 500;
    if (status === 500) request.log.error({ err: error }, "request failed");
    const code: ErrorCode =
      status === 404 ? "NOT_FOUND" : status === 500 ? "INTERNAL" : "VALIDATION_FAILED";
    return reply.code(status).send(envelope(code, bodyFields(error)));
  });

  // Requests without app headers (Admin, the website) and health checks are never refused.
  app.addHook("onRequest", async (request, reply) => {
    const name = request.headers[APP_NAME_HEADER];
    const version = request.headers[APP_VERSION_HEADER];
    if (name === undefined && version === undefined) return;
    if (request.routeOptions.url === "/v1/healthz") return;
    const identity = AppIdentity.safeParse({ name, version });
    if (!identity.success) return reply.code(400).send(envelope("VALIDATION_FAILED"));
    if (isOlder(identity.data.version, minAppVersions[identity.data.name])) {
      return reply.code(426).send(envelope("UPDATE_REQUIRED"));
    }
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send(envelope("NOT_FOUND")));

  if (database && mailer && clock && authTokenSecret) {
    registerAuthRoutes(app, { pool: database.pool, mailer, clock, secret: authTokenSecret, adminCookieDomain, identityVerifier });
    registerAdminRoutes(app, { pool: database.pool, clock, secret: authTokenSecret });
    registerCategoryRoutes(app, { pool: database.pool, clock, secret: authTokenSecret });
    registerMasterProductRoutes(app, { pool: database.pool, clock, secret: authTokenSecret, images: productImages });
    registerCatalogImportRoutes(app, { pool: database.pool, clock, secret: authTokenSecret, images: productImages });
    registerPackRoutes(app, { pool: database.pool, clock, secret: authTokenSecret });
    registerAreaRoutes(app, { pool: database.pool, clock, secret: authTokenSecret });
    registerProfileRoutes(app, { pool: database.pool, clock, secret: authTokenSecret });
    registerAddressRoutes(app, { pool: database.pool, clock, secret: authTokenSecret });
    registerPlaceRoutes(app, { pool: database.pool, clock, secret: authTokenSecret, places });
    registerShopRoutes(app, { pool: database.pool, clock, secret: authTokenSecret });
    registerShopListingRoutes(app, { pool: database.pool, clock, secret: authTokenSecret });
    registerShopAgreementRoutes(app, { pool: database.pool, clock, secret: authTokenSecret });
    registerShopHoursRoutes(app, { pool: database.pool, clock, secret: authTokenSecret });
    registerShopHolidayRoutes(app, { pool: database.pool, clock, secret: authTokenSecret });
    registerShopOpenRoutes(app, { pool: database.pool, clock, secret: authTokenSecret });
    registerShopVisitRoutes(app, { pool: database.pool, clock, secret: authTokenSecret, photos: visitPhotos });
    registerFeedRoutes(app, { pool: database.pool, clock, secret: authTokenSecret });
    registerRateCardRoutes(app, { pool: database.pool, clock, secret: authTokenSecret });
    registerPriceSimulatorRoutes(app, { pool: database.pool, clock, secret: authTokenSecret });
  }

  app.get(
    "/v1/healthz",
    { schema: { response: { 200: HealthResponse, 503: ErrorEnvelope } } },
    async (request, reply) => {
      try {
        await checkDatabase();
      } catch (err) {
        request.log.error({ err }, "database check failed");
        return reply.code(503).send(envelope("UNAVAILABLE"));
      }
      return { status: "ok" as const };
    },
  );

  // The mobile apps' launch check. The hook above has already refused a version
  // that is too old, so reaching the handler means this version is served.
  app.get("/v1/version-check", async (_request, reply) => reply.code(204).send());

  return app;
}
