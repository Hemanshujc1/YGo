import { File } from "expo-file-system";
import { printToFileAsync } from "expo-print";
import { shareAsync } from "expo-sharing";
import { strings } from "../strings";
import { billHtml, type BillPdf } from "./bill-pdf";
import { pdfFonts } from "./pdf-fonts";
import { billPdfClears, removeOldBillPdfs, retryBillPdfClear, shareFolder } from "./bill-pdf-files";

let queue: Promise<void> = Promise.resolve();

/**
 * Makes the bill's PDF on the phone, offline too, and opens the share sheet (#53). A4 at 72 points an inch.
 * The file is named after the bill so the customer sees "YGo bill A1B2-C3D4.pdf", in a folder of its own (#488).
 * Before each share, PDFs over an hour old are deleted; younger ones stay, since a receiving app may read one
 * after its share sheet closes.
 *
 * Shares run one at a time. There is no timeout: expo-sharing itself refuses a second share while one is pending,
 * so a stuck sheet would block sharing anyway.
 */
export function shareBill(input: Omit<BillPdf, "fonts">): Promise<void> {
  // Taken at the tap: a sign-out or account switch before this share's turn or during it means its PDF isn't kept.
  const clears = billPdfClears();
  const turn = queue.then(() => share(input, clears));
  queue = turn.catch(() => undefined);
  return turn;
}

async function share(input: Omit<BillPdf, "fonts">, clears: number): Promise<void> {
  const signedOut = () => { if (billPdfClears() !== clears) throw new Error("Signed out while sharing"); };
  signedOut();
  retryBillPdfClear();
  removeOldBillPdfs();
  const { uri } = await printToFileAsync({ html: billHtml({ ...input, fonts: await pdfFonts() }), width: 595, height: 842 });
  try {
    signedOut();
    const folder = shareFolder();
    const named = new File(folder, `${strings.bill.pdf.file(input.bill.reference)}.pdf`);
    try {
      await new File(uri).move(named);
      signedOut();
    } catch (error) {
      try { folder.delete(); } catch { /* the next routine cleanup removes it */ }
      throw error;
    }
    await shareAsync(named.uri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle: strings.bill.share });
  } finally {
    // A failed move leaves the printed PDF, with the customer's name, outside the bills folder.
    try { const left = new File(uri); if (left.exists) left.delete(); } catch { /* keep the share's own error */ }
  }
}
