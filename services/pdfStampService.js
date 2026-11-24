const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");

const isPdfFile = (file) => {
  if (!file) return false;
  const mime = (file.mime_type || "").toLowerCase();
  const name = (file.name || file.original_name || "").toLowerCase();
  return mime.includes("pdf") || name.endsWith(".pdf");
};

const FONT_SIZE = 11;
const PAD_X = 10;
const PAD_Y = 7;

/**
 * Use crop box when available so stamps center on the visible page area.
 */
const getPageBox = (page) => {
  try {
    if (typeof page.getCropBox === "function") {
      const box = page.getCropBox();
      if (box && box.width > 0 && box.height > 0) {
        return {
          x: box.x || 0,
          y: box.y || 0,
          width: box.width,
          height: box.height,
        };
      }
    }
  } catch (_) {
    // fall through
  }
  const { width, height } = page.getSize();
  return { x: 0, y: 0, width, height };
};

const measureTag = (font, text) => {
  const textWidth = font.widthOfTextAtSize(text, FONT_SIZE);
  return {
    boxW: textWidth + PAD_X * 2,
    boxH: FONT_SIZE + PAD_Y * 2,
  };
};

/**
 * White fill, colored border + text.
 */
const drawTagBox = (page, font, { text, x, y, border, fg, bg }) => {
  const { boxW, boxH } = measureTag(font, text);

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
    x: x + PAD_X,
    y: y + PAD_Y,
    size: FONT_SIZE,
    font,
    color: fg,
  });

  return { boxW, boxH };
};

const drawTopCenter = (page, font, text, colors) => {
  const box = getPageBox(page);
  const { boxW, boxH } = measureTag(font, text);
  drawTagBox(page, font, {
    text,
    x: box.x + (box.width - boxW) / 2,
    y: box.y + box.height - boxH - 24,
    ...colors,
  });
};

const drawBottomCenter = (page, font, text, colors) => {
  const box = getPageBox(page);
  const { boxW } = measureTag(font, text);
  drawTagBox(page, font, {
    text,
    x: box.x + (box.width - boxW) / 2,
    y: box.y + 24,
    ...colors,
  });
};

/**
 * Apply PDF document-control stamps.
 * - master: "MASTER COPY" — first page top-center
 * - controlled: "CONTROLLED COPY" — every page bottom-center
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
  const blue = rgb(0.08, 0.35, 0.75);
  const red = rgb(0.75, 0.12, 0.12);
  const white = rgb(1, 1, 1);

  const first = pages[0];
  const last = pages[pages.length - 1];

  if (master) {
    drawTopCenter(first, font, "MASTER COPY", {
      bg: white,
      border: green,
      fg: green,
    });
  }

  if (controlled) {
    for (const page of pages) {
      drawBottomCenter(page, font, "CONTROLLED COPY", {
        bg: white,
        border: blue,
        fg: blue,
      });
    }
  }

  if (obsolete) {
    drawTopCenter(first, font, "OBSOLETE", {
      bg: white,
      border: red,
      fg: red,
    });
    if (last !== first) {
      drawTopCenter(last, font, "OBSOLETE", {
        bg: white,
        border: red,
        fg: red,
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
