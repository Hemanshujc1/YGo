import regular from "@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf";
import medium from "@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf";
import semibold from "@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf";
import type { ReceiptResponse } from "@ygo/contracts";
import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import { printToFileAsync } from "expo-print";
import { shareAsync } from "expo-sharing";
import { strings } from "../strings";
import { receiptFolder, removeOldReceipts } from "./receipt-files";
import { receiptHtml } from "./receipt-pdf";

async function read(font: number): Promise<string> {
  const [asset] = await Asset.loadAsync(font);
  if (!asset?.localUri) throw new Error("Font file missing");
  return new File(asset.localUri).base64();
}

let queue: Promise<void> = Promise.resolve();

/**
 * Makes the receipt's PDF on the phone (A4 at 72 points an inch) and opens the share sheet (#61). It is moved into
 * a folder of its own as "YGo receipt #1042.pdf"; the printed temp file is deleted whether or not that works.
 * Shares run one at a time, since expo-sharing refuses a second while one is open.
 */
export function shareReceipt(receipt: ReceiptResponse): Promise<void> {
  const turn = queue.then(() => share(receipt));
  queue = turn.catch(() => undefined);
  return turn;
}

async function share(receipt: ReceiptResponse): Promise<void> {
  removeOldReceipts();
  const [r, m, s] = await Promise.all([read(regular), read(medium), read(semibold)]);
  const { uri } = await printToFileAsync({ html: receiptHtml({ receipt, fonts: { regular: r, medium: m, semibold: s } }), width: 595, height: 842 });
  try {
    const folder = receiptFolder();
    const named = new File(folder, `${strings.order.receipt.pdf.file(receipt.number)}.pdf`);
    try {
      await new File(uri).move(named);
    } catch (error) {
      try { folder.delete(); } catch { /* the next routine cleanup removes it */ }
      throw error;
    }
    await shareAsync(named.uri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle: strings.order.receipt.share });
  } finally {
    try { const left = new File(uri); if (left.exists) left.delete(); } catch { /* keep the share's own error */ }
  }
}
