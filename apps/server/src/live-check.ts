import type { Pool, PoolClient } from "pg";
import { AGREEMENT_VERSION, indiaToday, LiveBlocker, type LiveCheck } from "@ygo/contracts";
import { resolveRateCard } from "./routes/rate-cards";
import { affectingVersion } from "./routes/shop-agreement";

/**
 * What keeps an Approved shop `shopId` from going Live (ONB-2, ADR-0004), as
 * of `now`. A07 Move to Live and the Owner's S14 both read this, so the two
 * lists never disagree (owner's answers on #46 and #363). With `lock`, inside
 * a transaction that holds the shop's row, it also holds off what could change
 * the answer before commit: an Area save, a rate-card publish and the Owner's
 * contact change.
 */
export async function liveCheck(client: Pool | PoolClient, shopId: string, now: Date, lock = false): Promise<LiveCheck> {
  if (lock) {
    await client.query("LOCK TABLE area_pincodes IN SHARE MODE");
    await client.query("LOCK TABLE rate_card_versions IN SHARE MODE");
  }
  const version = await affectingVersion(client, shopId);
  const row = await client.query<Record<Exclude<LiveBlocker, "rate_card">, boolean>>(
    `SELECT s.fssai_expiry <= $2::date AS fssai_expired,
       NOT EXISTS (SELECT 1 FROM area_pincodes p WHERE p.pincode = s.pincode) AS pincode_not_in_area,
       -- Any visit counts: the visit route stores its photo with it, and DEL-10 removes a photo only after closure.
       NOT EXISTS (SELECT 1 FROM shop_visits v WHERE v.shop_id = s.id) AS visit,
       NOT (a.phone_verified OR a.phone_visit_confirmed_at IS NOT NULL) AS owner_phone,
       a.email_visit_confirmed_at IS NULL AS owner_email,
       NOT EXISTS (SELECT 1 FROM onboarding_fees f WHERE f.shop_id = s.id AND f.status IN ('paid', 'waived')) AS fee,
       NOT EXISTS (SELECT 1 FROM shop_agreement_acceptances c
         WHERE c.shop_id = s.id AND c.agreement_version = $3 AND c.rate_card_version::text = $4) AS agreement
     FROM shops s JOIN shop_members m ON m.shop_id = s.id AND m.role = 'owner' JOIN accounts a ON a.id = m.account_id
     WHERE s.id = $1${lock ? " FOR SHARE OF a" : ""}`,
    // The FSSAI expiry must be after today in India, as at Send (Q10 on #40).
    [shopId, indiaToday(now), AGREEMENT_VERSION, version],
  );
  const found = row.rows[0];
  if (!found) throw new Error("Shop vanished while checking it for Live");
  // Pickup and Bargain count only as the card itself asks (answer 9 on #46); #65 and #78 pass the shop's switches.
  const card = await resolveRateCard(client, shopId);
  const rateCardMissing = card?.missing ?? [];
  const blockers = LiveBlocker.options.filter((blocker) => blocker === "rate_card" ? !card?.complete : found[blocker]);
  return { blockers, rateCardMissing };
}
