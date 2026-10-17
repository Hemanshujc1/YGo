import { invalidFields } from "@ygo/contracts";
import type {
  FastifyError,
  FastifySchemaCompiler,
  FastifySerializerCompiler,
  FastifyTypeProvider,
} from "fastify";
import { ZodError, type z, type ZodType } from "zod";

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

/** The request-body fields a validation error names, for the error envelope. */
export function bodyFields(error: FastifyError): string[] | undefined {
  if (error.validationContext !== "body" || !(error instanceof ZodError)) return undefined;
  const fields = invalidFields(error);
  return fields.length > 0 ? fields : undefined;
}
