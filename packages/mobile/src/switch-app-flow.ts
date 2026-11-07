/** The link that opens each YGo app (`scheme` in its app.json). It carries no path and no data: sessions stay separate (#551, ACC-4). */
export const customerAppUrl = "ygo-customer://";
export const shopkeeperAppUrl = "ygo-shopkeeper://";

/** Tries to open the other app. False when it is not installed or the phone refuses; it never throws, so a failed switch changes nothing else. */
export async function openApp(open: (url: string) => Promise<unknown>, url: string): Promise<boolean> {
  try {
    await open(url);
    return true;
  } catch {
    return false;
  }
}
