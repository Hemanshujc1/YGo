import type { Statement } from "@ygo/contracts";
import { File } from "expo-file-system";
import { printToFileAsync } from "expo-print";
import { shareAsync } from "expo-sharing";
import { strings } from "../strings";
import { billPdfClears, removeOldBillPdfs, retryBillPdfClear, shareFolder } from "./bill-pdf-files";
import { pdfFonts } from "./pdf-fonts";
import { statementHtml } from "./statement-pdf";

/**
 * Makes the statement's PDF on the phone and opens the share sheet (#630), the way a counter bill's is (share-bill.ts): A4 at 72 points an inch,
 * in a share folder of its own so the file is named "YGo statement #7.pdf", and kept with the bill PDFs so the same cleanup and sign-out clear cover it.
 * The caller shares one at a time (its button waits), and the server makes no PDF.
 */
export async function shareStatement(statement: Statement): Promise<void> {
  // Taken at the tap: a sign-out or account switch during this share means its PDF is not kept, as for a bill.
  const clears = billPdfClears();
  const signedOut = () => { if (billPdfClears() !== clears) throw new Error("Signed out while sharing"); };
  retryBillPdfClear();
  removeOldBillPdfs();
  const { uri } = await printToFileAsync({ html: statementHtml({ statement, fonts: await pdfFonts() }), width: 595, height: 842 });
  try {
    const folder = shareFolder();
    const named = new File(folder, `${strings.money.pdf.file(statement.number)}.pdf`);
    try {
      signedOut();
      await new File(uri).move(named);
      signedOut();
    } catch (error) {
      try { folder.delete(); } catch { /* the next routine cleanup removes it */ }
      throw error;
    }
    await shareAsync(named.uri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle: strings.money.pdf.shareTitle });
  } finally {
    try { const left = new File(uri); if (left.exists) left.delete(); } catch { /* keep the share's own error */ }
  }
}
