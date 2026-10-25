import { AddressPoint } from "@ygo/contracts";

/** The phone's location calls, given by each app's screen so the tests can stand in for them. */
export interface Locator {
  /** Asks for location while the app is in use (#216, Q4); true when allowed. */
  askPermission(): Promise<boolean>;
  /** False when location is switched off for the whole phone. */
  servicesOn(): Promise<boolean>;
  /** Where the phone is now, and how close in metres when the phone says. Rejects when no position comes. */
  position(): Promise<{ latitude: number; longitude: number; accuracy?: number | null }>;
}

/**
 * What a "use my location" button found:
 * - `found`: where the phone is, and its accuracy in metres, or null when the phone gave none (#276, Q2).
 * - `off`: location was refused for this app.
 * - `phone-off`: location is switched off for the whole phone.
 * - `not-found`: no position in time, or one outside India.
 */
export type Found = { kind: "found"; point: AddressPoint; accuracy: number | null } | { kind: "off" | "phone-off" | "not-found" };

/** How long to wait for a position before giving up. */
const findTimeout = 15_000;

export async function findPlace(locator: Locator, timeout = findTimeout): Promise<Found> {
  let position;
  try {
    if (!(await locator.askPermission())) return { kind: "off" };
    if (!(await locator.servicesOn())) return { kind: "phone-off" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timed out")), timeout)));
    position = await Promise.race([locator.position(), late]).finally(() => clearTimeout(timer));
  } catch {
    return { kind: "not-found" };
  }
  // Latitude and longitude only: the phone's position also carries altitude and more.
  const point = AddressPoint.safeParse({ latitude: position.latitude, longitude: position.longitude });
  return point.success ? { kind: "found", point: point.data, accuracy: position.accuracy ?? null } : { kind: "not-found" };
}
