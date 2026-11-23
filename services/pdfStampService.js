const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");

const isPdfFile = (file) => {
  if (!file) return false;
  const mime = (file.mime_type || "").toLowerCase();
  const name = (file.name || file.original_name || "").toLowerCase();
  return mime.includes("pdf") || name.endsWith(".pdf");
};

const drawTagBox = (page, font, { text, x, y, bg, fg }) => {
  const fontSize = 11;
  const padX = 10;
  const padY = 7;
  const textWidth = font.widthOfTextAtSize(text, fontSize);
  const boxW = textWidth + padX * 2;
  const boxH = fontSize + padY * 2;

  page.drawRectangle({
    x,
    y,
    width: boxW,
    height: boxH,
    color: bg,
    opacity: 0.95,
  });

  page.drawText(text, {
    x: x + padX,
    y: y + padY,
    size: fontSize,
    font,
    color: fg,
  });

  return { boxW, boxH };
};

/**
 * Apply PDF document-control stamps.
 * - master: green "Master Copy" — first page top-right
 * - controlled: blue "Controlled Copy" — bottom-right
 * - obsolete: red "OBSOLETE" — first page + last page end/right
 */
const applyPdfStamps = async (pdfBuffer, options = {}) => {
  const { master = false, controlled = false, obsolete = false } = options;
  if (!master && !controlled && !obsolete) return pdfBuffer;

  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pages = pdfDoc.getPages();
  if (pages.length === 0) return pdfBuffer;

  const green = rgb(0.12, 0.55, 0.25);
  const blue = rgb(0.08, 0.28, 0.65);
  const red = rgb(0.75, 0.12, 0.12);
  const white = rgb(1, 1, 1);

  const first = pages[0];
  const last = pages[pages.length - 1];

  if (master) {
    const { width, height } = first.getSize();
    const label = "Master Copy";
    const textWidth = font.widthOfTextAtSize(label, 11);
    const boxW = textWidth + 20;
    drawTagBox(first, font, {
      text: label,
      x: width - boxW - 28,
      y: height - 42,
      bg: green,
      fg: white,
    });
  }

  if (controlled) {
    // Bottom-right blue tag (download)
    for (const page of pages) {
      const { width } = page.getSize();
      const label = "Controlled Copy";
      const textWidth = font.widthOfTextAtSize(label, 11);
      const boxW = textWidth + 20;
      drawTagBox(page, font, {
        text: label,
        x: width - boxW - 28,
        y: 24,
        bg: blue,
        fg: white,
      });
    }
  }

  if (obsolete) {
    // First page OBSOLETE (top-right)
    {
      const { width, height } = first.getSize();
      const label = "OBSOLETE";
      const textWidth = font.widthOfTextAtSize(label, 11);
      const boxW = textWidth + 20;
      drawTagBox(first, font, {
        text: label,
        x: width - boxW - 28,
        y: height - 42,
        bg: red,
        fg: white,
      });
    }

    // Last page OBSOLETE at end / right side (bottom-right)
    {
      const { width } = last.getSize();
      const label = "OBSOLETE";
      const textWidth = font.widthOfTextAtSize(label, 11);
      const boxW = textWidth + 20;
      drawTagBox(last, font, {
        text: label,
        x: width - boxW - 28,
        y: 24,
        bg: red,
        fg: white,
      });
    }
  }

  const stamped = await pdfDoc.save();
  return Buffer.from(stamped);
};

/** @deprecated compatibility wrapper */
const applyPdfStamp = async (pdfBuffer, stampType) => {
  if (stampType === "obsolete") {
    return applyPdfStamps(pdfBuffer, { obsolete: true });
  }
  if (stampType === "controlled") {
    return applyPdfStamps(pdfBuffer, { controlled: true, master: true });
  }
  if (stampType === "master") {
    return applyPdfStamps(pdfBuffer, { master: true });
  }
  return pdfBuffer;
};

module.exports = {
  isPdfFile,
  applyPdfStamp,
  applyPdfStamps,
};
