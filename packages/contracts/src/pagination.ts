import { z } from "zod";

/** One-based page-number pagination for stable directory and table lists. */
export const PageQuery = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type PageQuery = z.infer<typeof PageQuery>;

/** The page the server returned and the full number of records after filtering. */
export const PageInfo = z.strictObject({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
  totalRecords: z.number().int().nonnegative(),
});
export type PageInfo = z.infer<typeof PageInfo>;

/** A list response with one reusable pagination envelope. */
export const paginatedResponse = <Item extends z.ZodType>(item: Item) => z.strictObject({
  items: z.array(item),
  pagination: PageInfo,
});
