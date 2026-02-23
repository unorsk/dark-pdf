import { PDFiumLibrary } from "@hyzyla/pdfium";

const CELL_ASPECT = 0.5; // terminal cell width/height ratio (~8px wide, ~16px tall)

type RGB = { r: number; g: number; b: number };

// Query terminal for a color using OSC 10 (fg) or OSC 11 (bg)
// Terminal responds with e.g. \x1b]11;rgb:1f1f/1f1f/2727\x1b\\
function queryTerminalColor(osc: number): Promise<RGB | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      process.stdin.removeListener("data", handler);
      resolve(null);
    }, 500);

    const pattern = new RegExp(`\\]${osc};rgb:([0-9a-f]+)\\/([0-9a-f]+)\\/([0-9a-f]+)`, "i");

    function handler(data: Buffer) {
      const match = data.toString().match(pattern);
      if (match) {
        clearTimeout(timer);
        process.stdin.removeListener("data", handler);
        // Values can be 2 or 4 hex digits; normalize to 8-bit
        const parse = (hex: string) => {
          const v = parseInt(hex, 16);
          return hex.length <= 2 ? v : v >> 8;
        };
        resolve({ r: parse(match[1]), g: parse(match[2]), b: parse(match[3]) });
      }
    }

    process.stdin.on("data", handler);
    process.stdout.write(`\x1b]${osc};?\x1b\\`);
  });
}

async function getTerminalColors(): Promise<{ fg: RGB; bg: RGB }> {
  process.stdin.setRawMode(true);
  process.stdin.resume();

  // Query sequentially to avoid responses merging into one data event
  const fg = await queryTerminalColor(10);
  const bg = await queryTerminalColor(11);

  return {
    fg: fg ?? { r: 255, g: 255, b: 255 },
    bg: bg ?? { r: 0, g: 0, b: 0 },
  };
}

const { fg: termFg, bg: termBg } = await getTerminalColors();

// Parse args: [file] [--page N] [--margin-top N] [--margin-bottom N]
let pdfPath = "ddia2.pdf";
let startPage = 0;
let marginTop = 0;
let marginBottom = 0;
let marginLeft = 0;
let marginRight = 0;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  const next = process.argv[i + 1];
  if ((arg === "--page" || arg === "-p") && next) {
    startPage = Math.max(0, parseInt(process.argv[++i], 10) - 1);
  } else if (arg === "--margin-top" && next) {
    marginTop = Math.max(0, parseInt(process.argv[++i], 10));
  } else if (arg === "--margin-bottom" && next) {
    marginBottom = Math.max(0, parseInt(process.argv[++i], 10));
  } else if (arg === "--margin-left" && next) {
    marginLeft = Math.max(0, parseInt(process.argv[++i], 10));
  } else if (arg === "--margin-right" && next) {
    marginRight = Math.max(0, parseInt(process.argv[++i], 10));
  } else {
    pdfPath = process.argv[i];
  }
}

const pdfBytes = await Bun.file(pdfPath).arrayBuffer();

const library = await PDFiumLibrary.init();
const document = await library.loadDocument(new Uint8Array(pdfBytes));
const pageCount = document.getPageCount();

let currentPage = Math.min(startPage, pageCount - 1);

// Map PDF colors to terminal colors:
// PDF white (255) → terminal bg, PDF black (0) → terminal fg
// Linear interpolation: out = fg + (bg - fg) * (in / 255)
function remapBGRAtoRGBA(bgra: Uint8Array): Uint8Array {
  const rgba = new Uint8Array(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    const r = bgra[i + 2] / 255; // source R (BGRA layout)
    const g = bgra[i + 1] / 255;
    const b = bgra[i + 0] / 255;
    rgba[i + 0] = Math.round(termFg.r + (termBg.r - termFg.r) * r);
    rgba[i + 1] = Math.round(termFg.g + (termBg.g - termFg.g) * g);
    rgba[i + 2] = Math.round(termFg.b + (termBg.b - termFg.b) * b);
    rgba[i + 3] = 255;
  }
  return rgba;
}

function fitToTerminal(pageW: number, pageH: number): { cols: number; rows: number; padLeft: number } {
  const termCols = process.stdout.columns ?? 80;
  const termRows = (process.stdout.rows ?? 24) - 1; // leave 1 row for status

  // Calculate rows needed if we use full width
  let cols = termCols;
  let rows = Math.round((pageH / pageW) * cols * CELL_ASPECT);

  // If too tall, fit by height instead
  if (rows > termRows) {
    rows = termRows;
    cols = Math.round((pageW / pageH) * rows / CELL_ASPECT);
  }

  const padLeft = Math.max(0, Math.floor((termCols - cols) / 2));
  return { cols, rows, padLeft };
}

function writeKittyImage(rgba: Uint8Array, width: number, height: number, cols: number, rows: number) {
  const b64 = Buffer.from(rgba).toString("base64");
  const CHUNK = 4096;
  let offset = 0;
  let first = true;

  while (offset < b64.length) {
    const end = Math.min(offset + CHUNK, b64.length);
    const chunk = b64.slice(offset, end);
    const more = end < b64.length ? 1 : 0;

    if (first) {
      process.stdout.write(`\x1b_Ga=T,f=32,s=${width},v=${height},c=${cols},r=${rows},m=${more};${chunk}\x1b\\`);
      first = false;
    } else {
      process.stdout.write(`\x1b_Gm=${more};${chunk}\x1b\\`);
    }
    offset = end;
  }
}

function cropBitmap(data: Uint8Array, width: number, height: number, top: number, bottom: number, left: number, right: number) {
  const cropTop = Math.min(top, height);
  const cropBottom = Math.min(bottom, height - cropTop);
  const newHeight = height - cropTop - cropBottom;
  const cropLeft = Math.min(left, width);
  const cropRight = Math.min(right, width - cropLeft);
  const newWidth = width - cropLeft - cropRight;
  if (newHeight <= 0 || newWidth <= 0) return { data, width, height };

  const cropped = new Uint8Array(newWidth * newHeight * 4);
  const srcRowBytes = width * 4;
  const dstRowBytes = newWidth * 4;
  for (let y = 0; y < newHeight; y++) {
    const srcOffset = (cropTop + y) * srcRowBytes + cropLeft * 4;
    cropped.set(data.subarray(srcOffset, srcOffset + dstRowBytes), y * dstRowBytes);
  }
  return { data: cropped, width: newWidth, height: newHeight };
}

async function renderPage(pageIndex: number) {
  const page = document.getPage(pageIndex);
  const result = await page.render({ scale: 2, render: "bitmap" });

  const cropped = cropBitmap(result.data, result.width, result.height, marginTop, marginBottom, marginLeft, marginRight);
  const rgba = remapBGRAtoRGBA(cropped.data);
  const { cols, rows, padLeft } = fitToTerminal(cropped.width, cropped.height);

  // Clear screen, delete old images, home cursor
  process.stdout.write("\x1b_Ga=d\x1b\\");    // delete all kitty images
  process.stdout.write("\x1b[2J\x1b[H");       // clear screen + cursor home

  // Center horizontally
  if (padLeft > 0) process.stdout.write(`\x1b[${padLeft}C`);

  writeKittyImage(rgba, cropped.width, cropped.height, cols, rows);

  // Full-width status line at bottom
  const termCols = process.stdout.columns ?? 80;
  const status = ` Page ${pageIndex + 1}/${pageCount}  ←/→ navigate  q quit `;
  process.stdout.write(`\x1b[${(process.stdout.rows ?? 24)};1H`);
  process.stdout.write(`\x1b[7m${status.padEnd(termCols)}\x1b[0m`);
}

// Enter alternate screen, hide cursor
process.stdout.write("\x1b[?1049h\x1b[?25l");

function cleanup() {
  process.stdout.write("\x1b_Ga=d\x1b\\");     // delete images
  process.stdout.write("\x1b[?25h");            // show cursor
  process.stdout.write("\x1b[?1049l");          // leave alternate screen
  document.destroy();
  library.destroy();
}

process.on("exit", cleanup);
process.on("SIGINT", () => process.exit());
process.on("SIGTERM", () => process.exit());
let resizeTimer: Timer | null = null;
process.on("SIGWINCH", () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(async () => {
    if (!rendering) {
      rendering = true;
      await renderPage(currentPage);
      rendering = false;
    }
  }, 150);
});

// stdin already in raw mode from color query
let rendering = false;

process.stdin.on("data", async (data: Buffer) => {
  const key = data.toString();

  if (key === "q" || key === "\u0003") {
    process.exit(0);
  }

  if (rendering) return;

  if (key === "\x1b[C" && currentPage < pageCount - 1) {
    currentPage++;
    rendering = true;
    await renderPage(currentPage);
    rendering = false;
  } else if (key === "\x1b[D" && currentPage > 0) {
    currentPage--;
    rendering = true;
    await renderPage(currentPage);
    rendering = false;
  }
});

// Render first page
rendering = true;
await renderPage(currentPage);
rendering = false;
