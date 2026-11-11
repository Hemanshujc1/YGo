import { FulfilmentMode, type FulfilmentModeState } from "@ygo/contracts";
import type { Pool, PoolClient } from "pg";

/**
 * Where each mode stands before the shop touches its switch (FUL-1): the two delivery modes are on, as every shop delivers today, and pickup is off, so a
 * shop opts in (its rate card needs a pickup rule first, MNY-13). Admin's force-off starts off for all.
 */
export const START_ON: Record<FulfilmentMode, boolean> = { instant: true, scheduled: true, pickup: false };

/** All three modes of a shop; a mode with no row is at its start value. `open` is the shop's switch on and Admin's force-off not set. */
export async function fulfilmentModes(client: Pool | PoolClient, shopId: string): Promise<FulfilmentModeState[]> {
  const { rows } = await client.query<{ mode: FulfilmentMode; shopOn: boolean; adminForcedOff: boolean }>(
    `SELECT mode, shop_on AS "shopOn", admin_forced_off AS "adminForcedOff" FROM shop_fulfilment_modes WHERE shop_id = $1`, [shopId]);
  return FulfilmentMode.options.map((mode) => {
    const row = rows.find((candidate) => candidate.mode === mode);
    const shopOn = row ? row.shopOn : START_ON[mode];
    const adminForcedOff = row?.adminForcedOff ?? false;
    return { mode, shopOn, adminForcedOff, open: shopOn && !adminForcedOff };
  });
}
