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

/**
 * Makes the bill's PDF on the phone, offline too, and opens the share sheet (#53). A4 at 72 points an inch.
 * The file is named after the bill so the customer sees "YGo bill A1B2-C3D4.pdf". It holds the customer's name,
 * so the folder is emptied before each share and keeps only the latest; the receiving app may still be reading it.
 */
export async function shareBill(input: Omit<BillPdf, "fonts">): Promise<void> {
  const [r, m, s] = await Promise.all([read(regular), read(medium), read(semibold)]);
  const { uri } = await printToFileAsync({ html: billHtml({ ...input, fonts: { regular: r, medium: m, semibold: s } }), width: 595, height: 842 });
  const folder = new Directory(Paths.cache, "bills");
  if (folder.exists) folder.delete();
  folder.create();
  const named = new File(folder, `${strings.bill.pdf.file(input.bill.reference)}.pdf`);
  await new File(uri).move(named);
  await shareAsync(named.uri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle: strings.bill.share });
}
