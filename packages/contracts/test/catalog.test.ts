import { describe, expect, it } from "vitest";
import { CreateCategoryBody, CreateMasterProductBody, EditCategoryBody, EditMasterProductBody, ErrorEnvelope, invalidFields } from "../src/index";

const body = {
  name: "Apples",
  categoryId: "00000000-0000-4000-8000-000000000201",
  baseUnit: "each",
  classification: "counted",
  image: "aW1hZ2U=",
};

describe("master product contracts", () => {
  it("requires a base64 image for create and applies the 10 MiB encoded cap", () => {
    expect(CreateMasterProductBody.safeParse(body).success).toBe(true);
    const invalidBase64 = CreateMasterProductBody.safeParse({ ...body, image: "not base64!" });
    if (invalidBase64.success) throw new Error("expected bad base64 to be rejected");
    expect(invalidFields(invalidBase64.error)).toEqual(["image"]);
    const oversized = CreateMasterProductBody.safeParse({ ...body, image: "A".repeat(13_981_017) });
    if (oversized.success) throw new Error("expected the encoded size cap to be enforced");
    expect(invalidFields(oversized.error)).toEqual(["image"]);
  });

  it("allows image-free edits and requires a non-reason edit field", () => {
    expect(EditMasterProductBody.parse({ name: "Red apples" })).toEqual({ name: "Red apples" });
    expect(EditMasterProductBody.safeParse({ reason: "A reason alone is not an edit" }).success).toBe(false);
  });

  it.each(["name", "brand"])("rejects NUL in product %s on create and edit", (field) => {
    for (const schema of [CreateMasterProductBody, EditMasterProductBody]) {
      const result = schema.safeParse({ ...body, [field]: "Farm\0fresh" });
      if (result.success) throw new Error("expected NUL to be rejected");
      expect(invalidFields(result.error)).toEqual([field]);
    }
  });

  it("rejects NUL in category names on create and edit", () => {
    for (const schema of [CreateCategoryBody, EditCategoryBody]) {
      const result = schema.safeParse({ name: "Fruit\0fresh" });
      if (result.success) throw new Error("expected NUL to be rejected");
      expect(invalidFields(result.error)).toEqual(["name"]);
    }
  });

  it("carries a draft ID with an unavailable response for image retries", () => {
    const error = { error: { code: "UNAVAILABLE", draftId: "00000000-0000-4000-8000-000000000203" } };
    expect(ErrorEnvelope.parse(error)).toEqual(error);
  });
});
