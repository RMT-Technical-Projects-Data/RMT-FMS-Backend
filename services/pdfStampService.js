const { PDFDocument, rgb, degrees, StandardFonts } = require("pdf-lib");

const isPdfFile = (file) => {
  if (!file) return false;
  const mime = (file.mime_type || "").toLowerCase();
  const name = (file.name || file.original_name || "").toLowerCase();
  return mime.includes("pdf") || name.endsWith(".pdf");
};

/**
 * Origin point so rotated text is visually centered on the page.
 * pdf-lib rotates around the draw origin (bottom-left of the text).
 */
const centeredRotatedOrigin = (pageWidth, pageHeight, textWidth, textHeight, angleDeg) => {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = pageWidth / 2;
  const cy = pageHeight / 2;

  return {
    x: cx - (textWidth / 2) * cos + (textHeight / 2) * sin,
    y: cy - (textWidth / 2) * sin - (textHeight / 2) * cos,
  };
};

/**
 * Apply a stamp overlay to every page of a PDF.
 * - controlled: diagonal CONTROLLED watermark (page-centered, rotated)
 * - obsolete: diagonal OBSOLETE watermark (page-centered, rotated)
 */
const applyPdfStamp = async (pdfBuffer, stampType) => {
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pages = pdfDoc.getPages();

  for (const page of pages) {
    const { width, height } = page.getSize();

    if (stampType === "obsolete") {
      const fontSize = Math.min(width, height) * 0.12;
      const text = "OBSOLETE";
      const textWidth = font.widthOfTextAtSize(text, fontSize);
      const angle = 45;
      const { x, y } = centeredRotatedOrigin(
        width,
        height,
        textWidth,
        fontSize,
        angle
      );

      page.drawText(text, {
        x,
        y,
        size: fontSize,
        font,
        color: rgb(0.75, 0.1, 0.1),
        opacity: 0.45,
        rotate: degrees(angle),
      });
    } else {
      const fontSize = Math.min(width, height) * 0.1;
      const text = "CONTROLLED";
      const textWidth = font.widthOfTextAtSize(text, fontSize);
      const angle = -35;
      const { x, y } = centeredRotatedOrigin(
        width,
        height,
        textWidth,
        fontSize,
        angle
      );

      page.drawText(text, {
        x,
        y,
        size: fontSize,
        font,
        color: rgb(0.1, 0.25, 0.55),
        opacity: 0.32,
        rotate: degrees(angle),
      });
    }
  }

  const stamped = await pdfDoc.save();
  return Buffer.from(stamped);
};

module.exports = {
  isPdfFile,
  applyPdfStamp,
};
