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

const pdfPath = process.argv[2] ?? "ddia2.pdf";
const pdfBytes = await Bun.file(pdfPath).arrayBuffer();

const library = await PDFiumLibrary.init();
const document = await library.loadDocument(new Uint8Array(pdfBytes));
const pageCount = document.getPageCount();

let currentPage = 0;

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

function fitToTerminal(pageW: number, pageH: number): { cols: number; rows: number } {
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

  return { cols, rows };
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

async function renderPage(pageIndex: number) {
  const page = document.getPage(pageIndex);
  const result = await page.render({ scale: 2, render: "bitmap" });

  const rgba = remapBGRAtoRGBA(result.data);
  const { cols, rows } = fitToTerminal(result.width, result.height);

  // Clear screen, delete old images, home cursor
  process.stdout.write("\x1b_Ga=d\x1b\\");    // delete all kitty images
  process.stdout.write("\x1b[2J\x1b[H");       // clear screen + cursor home

  writeKittyImage(rgba, result.width, result.height, cols, rows);

  // Status line at bottom
  process.stdout.write(`\x1b[${(process.stdout.rows ?? 24)};1H`);
  process.stdout.write(`\x1b[7m Page ${pageIndex + 1}/${pageCount}  ←/→ navigate  q quit \x1b[0m`);
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
