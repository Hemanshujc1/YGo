import { SaveShopApplicationBody, ServiceRadiusMetres, type ShopApplication, type ShopEntityType } from "@ygo/contracts";

/** The S17 fields typed as text. Business type and service radius are picked; location joins in #295. */
export const textFields = ["shopName", "address", "pincode", "ownerName", "pan", "fssaiNumber", "fssaiExpiry", "upiId"] as const;
export type TextField = (typeof textFields)[number];

/** A field that can show a message under it. */
export type Field = TextField | "entityType";

/** The form as on screen. */
export type Typed = Record<TextField, string> & { entityType: ShopEntityType | null; serviceRadiusMetres: number };

/** The form for a saved application: an empty field shows blank, and the FSSAI expiry as DD/MM/YYYY (#276, Q3). */
export function typedFrom(application: ShopApplication): Typed {
  const typed = Object.fromEntries(textFields.map((field) => [field, application[field] ?? ""])) as Record<TextField, string>;
  return {
    ...typed,
    fssaiExpiry: application.fssaiExpiry ? typedDate(application.fssaiExpiry) : "",
    entityType: application.entityType,
    serviceRadiusMetres: application.serviceRadiusMetres,
  };
}

/** A saved YYYY-MM-DD date as DD/MM/YYYY, rearranged rather than formatted, so isoDate always reads it back. */
export function typedDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

/** A typed DD/MM/YYYY date as YYYY-MM-DD. Anything without three parts is kept as typed, so the date rule refuses it. */
export function isoDate(typed: string): string {
  const [day, month, year, ...rest] = typed.split("/").map((part) => part.trim());
  if (day === undefined || month === undefined || year === undefined || rest.length > 0) return typed;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * Save draft's body (#276, Q5): every field, an empty one as null, checked
 * with the server's rules. A filled-in field that breaks its rule stops the
 * save and is named. Location is left out, so the saved one stays.
 */
export function draftBody(typed: Typed): { ok: true; body: SaveShopApplicationBody } | { ok: false; wrong: Field[] } {
  const body = {
    ...Object.fromEntries(
      textFields.map((field) => {
        const value = typed[field].trim();
        return [field, value === "" ? null : field === "fssaiExpiry" ? isoDate(value) : value];
      }),
    ),
    entityType: typed.entityType,
    serviceRadiusMetres: typed.serviceRadiusMetres,
  };
  const checked = SaveShopApplicationBody.safeParse(body);
  if (checked.success) return { ok: true, body: checked.data };
  return { ok: false, wrong: shown(checked.error.issues.map((issue) => String(issue.path[0]))) };
}

/** The named fields this form shows, such as the `error.fields` of a refusal. */
export function shown(fields: string[] | undefined): Field[] {
  return (fields ?? []).filter((field): field is Field => field === "entityType" || textFields.includes(field as TextField));
}

/** True when the form differs from what was last saved. */
export function changed(typed: Typed, saved: Typed): boolean {
  return (Object.keys(typed) as (keyof Typed)[]).some((key) => typed[key] !== saved[key]);
}

/** The service radius one 0.5 km step away, or null past the 0.5–5 km rule (#276, Q4). */
export function stepRadius(metres: number, direction: -1 | 1): number | null {
  const next = metres + direction * 500;
  return ServiceRadiusMetres.safeParse(next).success ? next : null;
}
