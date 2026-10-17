import type {
  FastifySchemaCompiler,
  FastifySerializerCompiler,
  FastifyTypeProvider,
} from "fastify";
import type { z, ZodType } from "zod";

// Lets a route's `schema` hold @ygo/contracts schemas directly: requests are
// parsed by them on the way in and responses on the way out, and the handler's
// types come from the same objects the clients use.

export interface ZodTypeProvider extends FastifyTypeProvider {
  validator: this["schema"] extends ZodType ? z.output<this["schema"]> : unknown;
  serializer: this["schema"] extends ZodType ? z.input<this["schema"]> : unknown;
}

export const validatorCompiler: FastifySchemaCompiler<ZodType> =
  ({ schema }) =>
  (data) => {
    const result = schema.safeParse(data);
    return result.success ? { value: result.data } : { error: result.error };
  };

export const serializerCompiler: FastifySerializerCompiler<ZodType> =
  ({ schema }) =>
  (data) =>
    JSON.stringify(schema.parse(data));
