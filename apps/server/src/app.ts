import { ErrorEnvelope, HealthResponse, type ErrorCode } from "@ygo/contracts";
import Fastify, { type FastifyError, type FastifyServerOptions } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "./zod";

export interface AppOptions {
  /** Resolves when the database answers; rejects otherwise. */
  checkDatabase: () => Promise<void>;
  logger?: FastifyServerOptions["logger"];
}

const envelope = (code: ErrorCode): ErrorEnvelope => ({ error: { code } });

export function buildApp({ checkDatabase, logger = false }: AppOptions) {
  const app = Fastify({ logger }).withTypeProvider<ZodTypeProvider>();
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
    return reply.code(status).send(envelope(code));
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send(envelope("NOT_FOUND")));

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

  return app;
}
