const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");

const isPdfFile = (file) => {
  if (!file) return false;
  const mime = (file.mime_type || "").toLowerCase();
  const name = (file.name || file.original_name || "").toLowerCase();
  return mime.includes("pdf") || name.endsWith(".pdf");
};

/**
 * White fill, green border, green text — centered via returned box size.
 */
const drawTagBox = (page, font, { text, x, y, border, fg, bg }) => {
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
    borderColor: border,
    borderWidth: 1.5,
    opacity: 1,
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

const measureTag = (font, text) => {
  const fontSize = 11;
  const padX = 10;
  const padY = 7;
  const textWidth = font.widthOfTextAtSize(text, fontSize);
  return {
    boxW: textWidth + padX * 2,
    boxH: fontSize + padY * 2,
  };
};

/**
 * Apply PDF document-control stamps.
 * Style (all): green text, white fill, green border
 * - master: "Master Copy" — first page top-center
 * - controlled: "Controlled Copy" — every page bottom-center
 * - obsolete: "OBSOLETE" — first + last page top-center
 */
const applyPdfStamps = async (pdfBuffer, options = {}) => {
  const { master = false, controlled = false, obsolete = false } = options;
  if (!master && !controlled && !obsolete) return pdfBuffer;

  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pages = pdfDoc.getPages();
  if (pages.length === 0) return pdfBuffer;

  const green = rgb(0.12, 0.55, 0.25);
  const white = rgb(1, 1, 1);
  const tagStyle = { bg: white, border: green, fg: green };

  const first = pages[0];
  const last = pages[pages.length - 1];

  if (master) {
    const { width, height } = first.getSize();
    const label = "Master Copy";
    const { boxW, boxH } = measureTag(font, label);
    drawTagBox(first, font, {
      text: label,
      x: (width - boxW) / 2,
      y: height - boxH - 24,
      ...tagStyle,
    });
  }

  if (controlled) {
    for (const page of pages) {
      const { width } = page.getSize();
      const label = "Controlled Copy";
      const { boxW } = measureTag(font, label);
      drawTagBox(page, font, {
        text: label,
        x: (width - boxW) / 2,
        y: 24,
        ...tagStyle,
      });
    }
  }

  if (obsolete) {
    const label = "OBSOLETE";
    const { boxW, boxH } = measureTag(font, label);

    {
      const { width, height } = first.getSize();
      drawTagBox(first, font, {
        text: label,
        x: (width - boxW) / 2,
        y: height - boxH - 24,
        ...tagStyle,
      });
    }

    if (last !== first) {
      const { width, height } = last.getSize();
      drawTagBox(last, font, {
        text: label,
        x: (width - boxW) / 2,
        y: height - boxH - 24,
        ...tagStyle,
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
