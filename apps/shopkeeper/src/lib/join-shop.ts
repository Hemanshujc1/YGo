import type { MyShopApplicationResponse, SyncAccessResponse } from "@ygo/contracts";

/**
 * After the server links the account (S21), the phone must see it as Staff of that shop before it opens Home: the access
 * check is refreshed (it saves the role for offline) and the application read confirms the shop Staff work in (#536).
 * True when both agree; false means the link exists but this phone could not take it up yet.
 */
export async function takeUpJoin(
  verify: () => Promise<SyncAccessResponse | null>,
  application: () => Promise<{ ok: true; data: MyShopApplicationResponse } | { ok: false }>,
): Promise<boolean> {
  const access = await verify().catch(() => null);
  if (access?.role !== "staff") return false;
  const read = await application().catch(() => null);
  return read?.ok === true && read.data.staffShop !== null;
}
