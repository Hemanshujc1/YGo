import {
  type AddressPoint,
  CalendarDate,
  invalidFields,
  SaveShopApplicationBody,
  SendShopApplicationBody,
  ServiceRadiusMetres,
  ShopAddress,
  type ShopApplication,
  type ShopEntityType,
} from "@ygo/contracts";
import type { AddressAt } from "@ygo/mobile/address-at";

/** The S17 fields typed as text. Business type and service radius are picked, and the location comes from the phone. */
export const textFields = ["shopName", "address", "pincode", "ownerName", "pan", "fssaiNumber", "fssaiExpiry", "upiId"] as const;
export type TextField = (typeof textFields)[number];

/** A field that can show a message under it. */
export type Field = TextField | "entityType" | "location";

/** The form as on screen. */
export type Typed = Record<TextField, string> & {
  entityType: ShopEntityType | null;
  serviceRadiusMetres: number;
  location: AddressPoint | null;
};

/** The form for a saved application: an empty field shows blank, and the FSSAI expiry as DD/MM/YYYY (#276, Q3). */
export function typedFrom(application: ShopApplication): Typed {
  const typed = Object.fromEntries(textFields.map((field) => [field, application[field] ?? ""])) as Record<TextField, string>;
  return {
    ...typed,
    fssaiExpiry: application.fssaiExpiry ? typedDate(application.fssaiExpiry) : "",
    entityType: application.entityType,
    serviceRadiusMetres: application.serviceRadiusMetres,
    location: application.location,
  };
}

/**
 * The empty Pincode and Address that the address at the shop's location fills
 * in; a box with text is never changed (#303). The Address is the address's
 * line, cut to the Address rule's length (#303, Q2).
 */
export function fillFromLocation(typed: Typed, at: AddressAt | null): Partial<Pick<Typed, "pincode" | "address">> {
  if (!at) return {};
  const address = ShopAddress.safeParse(at.line.slice(0, ShopAddress.maxLength ?? undefined));
  return {
    ...(typed.pincode.trim() === "" && { pincode: at.pincode }),
    ...(typed.address.trim() === "" && address.success && { address: address.data }),
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
 * Every field as the server takes it: trimmed, an empty one as null, and the
 * expiry as YYYY-MM-DD. The location is left out until the phone gives one,
 * so a save never erases one taken at the shop on another phone (#295 review, Q5).
 */
function bodyFrom(typed: Typed) {
  return {
    ...Object.fromEntries(
      textFields.map((field) => {
        const value = typed[field].trim();
        return [field, value === "" ? null : field === "fssaiExpiry" ? isoDate(value) : value];
      }),
    ),
    entityType: typed.entityType,
    serviceRadiusMetres: typed.serviceRadiusMetres,
    ...(typed.location && { location: typed.location }),
  };
}

/**
 * Save draft's body (#276, Q5): every field, an empty one as null, checked
 * with the server's rules. A filled-in field that breaks its rule stops the
 * save and is named.
 */
export function draftBody(typed: Typed): { ok: true; body: SaveShopApplicationBody } | { ok: false; wrong: Field[] } {
  const checked = SaveShopApplicationBody.safeParse(bodyFrom(typed));
  return checked.success ? { ok: true, body: checked.data } : { ok: false, wrong: shown(invalidFields(checked.error)) };
}

/** Send's body (#295): every field must be filled in and keep its rule, and the FSSAI licence must be valid after today. */
export function sendBody(typed: Typed): { ok: true; body: SendShopApplicationBody } | { ok: false; wrong: Field[] } {
  const checked = SendShopApplicationBody.safeParse(bodyFrom(typed));
  return checked.success ? { ok: true, body: checked.data } : { ok: false, wrong: shown(invalidFields(checked.error)) };
}

/**
 * True when the typed FSSAI expiry is a real date. A refused one then has
 * passed, whichever clock refused it: the phone's or the server's (#295 review, Q2).
 */
export function realDate(typed: Typed): boolean {
  return CalendarDate.safeParse(isoDate(typed.fssaiExpiry.trim())).success;
}

/**
 * The named fields this form shows, such as the `error.fields` of a refusal.
 * A part of a field, such as `location.latitude`, names the field.
 */
export function shown(fields: string[] | undefined): Field[] {
  const named = new Set((fields ?? []).map((field) => field.split(".")[0] ?? field));
  return [...named].filter((field): field is Field => field === "entityType" || field === "location" || textFields.includes(field as TextField));
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
