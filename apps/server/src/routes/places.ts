import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  AddressPoint,
  ErrorEnvelope,
  PlacePointQuery,
  PlacePointResponse,
  PlaceSearchQuery,
  PlaceSearchResponse,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import type { PlaceFinder } from "../adapters/place-finder";
import { deriveKeys, mobileSignedIn } from "../tokens";

/** Per account, searches and picks each (#257, Q8). */
const LIMIT = 30;
const WINDOW_MS = 60 * 60 * 1000;

/**
 * Whether an account may make one more call in the last hour, counting it if
 * so. Kept in memory: a restart forgets the counts, which only lets a few
 * extra calls through. Once an hour it forgets accounts with no call that hour.
 */
function hourlyLimit(clock: Clock): (accountId: string) => boolean {
  const calls = new Map<string, number[]>();
  let swept = clock.now().getTime();
  return (accountId) => {
    const now = clock.now().getTime();
    if (now - swept >= WINDOW_MS) {
      for (const [id, times] of calls) if (now - (times.at(-1) ?? 0) >= WINDOW_MS) calls.delete(id);
      swept = now;
    }
    const recent = (calls.get(accountId) ?? []).filter((at) => now - at < WINDOW_MS);
    const allowed = recent.length < LIMIT;
    if (allowed) recent.push(now);
    calls.set(accountId, recent);
    return allowed;
  };
}

const failed = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 429: ErrorEnvelope, 503: ErrorEnvelope };

/** C15's place search through Google Places (#257); without a finder (no key) both answer UNAVAILABLE. */
export function registerPlaceRoutes(
  app: FastifyInstance,
  { pool, clock, secret, places }: { pool: Pool; clock: Clock; secret: string; places?: PlaceFinder },
): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const searches = hourlyLimit(clock);
  const picks = hourlyLimit(clock);

  app.get("/v1/places", { schema: { querystring: PlaceSearchQuery, response: { 200: PlaceSearchResponse, ...failed } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    if (!places) return reply.code(503).send({ error: { code: "UNAVAILABLE" } });
    if (!searches(who.accountId)) return reply.code(429).send({ error: { code: "TOO_MANY_REQUESTS" } });
    const { text, session } = request.query as PlaceSearchQuery;
    try {
      return { matches: await places.search(text, session) };
    } catch (err) {
      request.log.error({ err }, "place search failed");
      return reply.code(503).send({ error: { code: "UNAVAILABLE" } });
    }
  });

  app.get("/v1/places/point", { schema: { querystring: PlacePointQuery, response: { 200: PlacePointResponse, 404: ErrorEnvelope, ...failed } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    if (!places) return reply.code(503).send({ error: { code: "UNAVAILABLE" } });
    if (!picks(who.accountId)) return reply.code(429).send({ error: { code: "TOO_MANY_REQUESTS" } });
    const { id, session } = request.query as PlacePointQuery;
    let point;
    try {
      point = await places.point(id, session);
    } catch (err) {
      request.log.error({ err }, "place point failed");
      return reply.code(503).send({ error: { code: "UNAVAILABLE" } });
    }
    // A place Google lost, or one outside the box around India, can't be confirmed.
    const inIndia = AddressPoint.safeParse(point);
    if (!inIndia.success) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    return { point: inIndia.data };
  });
}
