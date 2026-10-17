import { z } from "zod";

/** `GET /v1/healthz` when the server and its database both answer. */
export const HealthResponse = z.object({
  status: z.literal("ok"),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
