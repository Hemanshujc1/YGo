import { describe, expect, it } from "vitest";
import { PageInfo, PageQuery, paginatedResponse } from "../src/index";
import { z } from "zod";

describe("page-number pagination contracts", () => {
  it("defaults to the first page of 50 and coerces query strings", () => {
    expect(PageQuery.parse({})).toEqual({ page: 1, pageSize: 50 });
    expect(PageQuery.parse({ page: "2", pageSize: "25" })).toEqual({ page: 2, pageSize: 25 });
  });

  it.each([
    { page: 0, pageSize: 50 },
    { page: 1.5, pageSize: 50 },
    { page: 1, pageSize: 0 },
    { page: 1, pageSize: 101 },
  ])("refuses an invalid boundary: %o", (value) => {
    expect(PageQuery.safeParse(value).success).toBe(false);
  });

  it("validates reusable page metadata and list items", () => {
    const response = paginatedResponse(z.strictObject({ id: z.uuid() }));
    const value = {
      items: [{ id: "00000000-0000-4000-8000-000000000001" }],
      pagination: { page: 2, pageSize: 25, totalRecords: 26 },
    };
    expect(response.parse(value)).toEqual(value);
    expect(PageInfo.safeParse({ ...value.pagination, totalRecords: -1 }).success).toBe(false);
    expect(response.safeParse({ ...value, extra: true }).success).toBe(false);
  });
});
