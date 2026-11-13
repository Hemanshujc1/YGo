import regular from "@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf";
import medium from "@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf";
import semibold from "@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf";
import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import type { BillFonts } from "./bill-pdf";

// Read when a PDF is shared, not kept in memory: PDFs are shared now and then.
async function read(font: number): Promise<string> {
  const [asset] = await Asset.loadAsync(font);
  if (!asset?.localUri) throw new Error("Font file missing");
  return new File(asset.localUri).base64();
}

/** Inter's three weights as base64, for the PDFs made on the phone (bills #53, statements #630). */
export async function pdfFonts(): Promise<BillFonts> {
  const [r, m, s] = await Promise.all([read(regular), read(medium), read(semibold)]);
  return { regular: r, medium: m, semibold: s };
}
