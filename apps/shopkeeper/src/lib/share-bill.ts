import regular from "@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf";
import medium from "@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf";
import semibold from "@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf";
import { Asset } from "expo-asset";
import { Directory, File, Paths } from "expo-file-system";
import { printToFileAsync } from "expo-print";
import { shareAsync } from "expo-sharing";
import { strings } from "../strings";
import { billHtml, type BillPdf } from "./bill-pdf";

// Read when a bill is shared, not kept in memory: bills are shared now and then.
async function read(font: number): Promise<string> {
  const [asset] = await Asset.loadAsync(font);
  if (!asset?.localUri) throw new Error("Font file missing");
  return new File(asset.localUri).base64();
}

let queue: Promise<void> = Promise.resolve();

/**
 * Makes the bill's PDF on the phone, offline too, and opens the share sheet (#53). A4 at 72 points an inch.
 * The file is named after the bill so the customer sees "YGo bill A1B2-C3D4.pdf". It holds the customer's name,
 * so the folder is emptied before each share and keeps only the latest.
 *
 * Shares run one at a time, so emptying the folder never removes the PDF of a share still in progress.
 * There is no timeout: expo-sharing itself refuses a second share while one is pending, so a stuck sheet
 * would block sharing anyway. This does not cover a receiving app that keeps reading after its share finished.
 */
export function shareBill(input: Omit<BillPdf, "fonts">): Promise<void> {
  const turn = queue.then(() => share(input));
  queue = turn.catch(() => undefined);
  return turn;
}

async function share(input: Omit<BillPdf, "fonts">): Promise<void> {
  const [r, m, s] = await Promise.all([read(regular), read(medium), read(semibold)]);
  const { uri } = await printToFileAsync({ html: billHtml({ ...input, fonts: { regular: r, medium: m, semibold: s } }), width: 595, height: 842 });
  try {
    const folder = new Directory(Paths.cache, "bills");
    if (folder.exists) folder.delete();
    folder.create();
    const named = new File(folder, `${strings.bill.pdf.file(input.bill.reference)}.pdf`);
    await new File(uri).move(named);
    await shareAsync(named.uri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle: strings.bill.share });
  } finally {
    // A failed move leaves the printed PDF, with the customer's name, outside the bills folder.
    try { const left = new File(uri); if (left.exists) left.delete(); } catch { /* keep the share's own error */ }
  }
}
