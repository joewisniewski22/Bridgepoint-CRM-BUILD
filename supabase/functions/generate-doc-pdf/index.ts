// Renders a plain-text loan document (Pre-Approval Letter, Term Sheet) that
// the CRM already builds client-side into a real, letterhead-branded PDF.
// Pure renderer -- the frontend remains the single source of truth for the
// document's wording/bilingual content; this just typesets it.
//
// The incoming text is a flat "\n"-joined string with no structure markup,
// so this parses it heuristically into blocks (title, section heading,
// label/value rows, fine-print disclaimer, signature block) and lays each
// out properly -- rather than dumping every line in one plain font like a
// typewriter, which is what this used to do.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "https://esm.sh/pdf-lib@1.17.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const LOGO_URL = SUPABASE_URL + "/storage/v1/object/public/public-assets/logo.jpg";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;

// Brand palette, matched to the CRM's own CSS variables.
const NAVY = rgb(0x1b / 255, 0x2a / 255, 0x47 / 255);
const NAVY_SOFT = rgb(0.35, 0.40, 0.48);
const GOLD = rgb(0xa9 / 255, 0x81 / 255, 0x2e / 255);
const INK = rgb(0.11, 0.10, 0.08);
const GRAY = rgb(0.45, 0.45, 0.45);
const LINE_GRAY = rgb(0.82, 0.82, 0.82);
const ROW_TINT = rgb(0.949, 0.957, 0.969);

const SIGNATURE_TRIGGERS = ["Prepared by,", "Preparado por,", "Sincerely,", "Atentamente,"];

type Block =
  | { type: "title"; text: string }
  | { type: "subtitle"; text: string }
  | { type: "heading"; text: string }
  | { type: "table"; rows: { label: string; value: string }[] }
  | { type: "emphasis"; text: string }
  | { type: "fineprint"; text: string }
  | { type: "para"; text: string }
  | { type: "sig"; lines: string[] }
  | { type: "spacer" };

function isAllCapsHeading(raw: string): boolean {
  const t = raw.trim();
  return t.length > 0 && t === t.toUpperCase() && /[A-Z]/.test(t) && !/\d\)$/.test(t);
}
function matchRow(raw: string): { label: string; value: string } | null {
  const m = raw.match(/^([^:]{2,40}):\s+(.+)$/);
  if (!m) return null;
  const label = m[1].trim();
  if (label.toLowerCase() === "re") return null;
  return { label, value: m[2].trim() };
}

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let sawTitle = false;
  let sawSubtitle = false;

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (trimmed === "") {
      blocks.push({ type: "spacer" });
      i++;
      continue;
    }
    if (SIGNATURE_TRIGGERS.indexOf(trimmed) !== -1) {
      const sigLines: string[] = [];
      i++;
      while (i < lines.length) {
        if (lines[i].trim() !== "") sigLines.push(lines[i].trim());
        i++;
      }
      blocks.push({ type: "sig", lines: sigLines });
      continue;
    }
    if (!sawTitle) {
      blocks.push({ type: "title", text: trimmed });
      sawTitle = true;
      i++;
      continue;
    }
    if (!sawSubtitle) {
      blocks.push({ type: "subtitle", text: trimmed });
      sawSubtitle = true;
      i++;
      continue;
    }
    if (isAllCapsHeading(raw)) {
      blocks.push({ type: "heading", text: trimmed });
      i++;
      continue;
    }
    if (/^Re:\s/i.test(trimmed)) {
      blocks.push({ type: "emphasis", text: trimmed });
      i++;
      continue;
    }
    const row = matchRow(trimmed);
    if (row) {
      const rows = [row];
      i++;
      while (i < lines.length) {
        const nextRow = lines[i].trim() !== "" ? matchRow(lines[i].trim()) : null;
        if (!nextRow) break;
        rows.push(nextRow);
        i++;
      }
      blocks.push({ type: "table", rows });
      continue;
    }
    if (trimmed.length > 130) {
      blocks.push({ type: "fineprint", text: trimmed });
      i++;
      continue;
    }
    blocks.push({ type: "para", text: trimmed });
    i++;
  }
  return blocks;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (!text) return [""];
  const words = text.split(" ");
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (line && font.widthOfTextAtSize(test, size) > maxWidth) {
      out.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  out.push(line);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const text: string = body.text;
    const label: string = body.label || "Document";
    if (!text || typeof text !== "string") {
      return new Response(JSON.stringify({ error: "missing_text" }), { status: 400, headers: CORS_HEADERS });
    }

    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle("Bridgepoint Lending — " + label);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const italic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

    let logoImg = null;
    let logoDims: { width: number; height: number } | null = null;
    try {
      const logoRes = await fetch(LOGO_URL);
      if (logoRes.ok) {
        const logoBytes = new Uint8Array(await logoRes.arrayBuffer());
        logoImg = await pdfDoc.embedJpg(logoBytes);
        const scale = Math.min(1, 130 / logoImg.width);
        logoDims = logoImg.scale(scale);
      }
    } catch (_e) {
      // Logo is a nice-to-have; never fail the whole PDF over it.
    }

    let pageNum = 0;
    let page: PDFPage = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MARGIN;
    pageNum++;

    function drawFooter(p: PDFPage) {
      p.drawLine({ start: { x: MARGIN, y: 34 }, end: { x: PAGE_W - MARGIN, y: 34 }, thickness: 0.75, color: LINE_GRAY });
      p.drawText("Bridgepoint Lending — Real Estate Financing Solutions", { x: MARGIN, y: 22, size: 8, font, color: GRAY });
      const pageLabel = "Page " + pageNum;
      const pw = font.widthOfTextAtSize(pageLabel, 8);
      p.drawText(pageLabel, { x: PAGE_W - MARGIN - pw, y: 22, size: 8, font, color: GRAY });
    }

    function newPage() {
      drawFooter(page);
      page = pdfDoc.addPage([PAGE_W, PAGE_H]);
      pageNum++;
      y = PAGE_H - MARGIN;
    }
    function ensureRoom(needed: number) {
      if (y - needed < MARGIN + 40) newPage();
    }

    const blocks = parseBlocks(text);

    for (const block of blocks) {
      if (block.type === "title") {
        ensureRoom(logoDims ? logoDims.height + 34 : 34);
        if (logoImg && logoDims) {
          page.drawImage(logoImg, { x: MARGIN, y: y - logoDims.height, width: logoDims.width, height: logoDims.height });
          y -= logoDims.height + 10;
        }
        page.drawText(block.text, { x: MARGIN, y: y - 18, size: 17, font: bold, color: NAVY });
        y -= 26;
        continue;
      }
      if (block.type === "subtitle") {
        ensureRoom(24);
        page.drawText(block.text, { x: MARGIN, y: y - 11, size: 10.5, font: italic, color: GOLD });
        y -= 14;
        page.drawLine({ start: { x: MARGIN, y: y - 4 }, end: { x: PAGE_W - MARGIN, y: y - 4 }, thickness: 1.5, color: GOLD });
        y -= 22;
        continue;
      }
      if (block.type === "spacer") {
        y -= 8;
        continue;
      }
      if (block.type === "heading") {
        ensureRoom(30);
        y -= 6;
        page.drawText(block.text, { x: MARGIN, y: y - 12, size: 11.5, font: bold, color: NAVY });
        y -= 16;
        page.drawLine({ start: { x: MARGIN, y: y }, end: { x: MARGIN + 40, y: y }, thickness: 1.5, color: GOLD });
        y -= 12;
        continue;
      }
      if (block.type === "emphasis") {
        ensureRoom(20);
        for (const w of wrapText(block.text, bold, 10.5, CONTENT_W)) {
          ensureRoom(16);
          page.drawText(w, { x: MARGIN, y: y - 10.5, size: 10.5, font: bold, color: NAVY });
          y -= 16;
        }
        continue;
      }
      if (block.type === "fineprint") {
        ensureRoom(20);
        y -= 4;
        for (const w of wrapText(block.text, italic, 8.5, CONTENT_W)) {
          ensureRoom(13);
          page.drawText(w, { x: MARGIN, y: y - 8.5, size: 8.5, font: italic, color: GRAY });
          y -= 12.5;
        }
        y -= 4;
        continue;
      }
      if (block.type === "sig") {
        ensureRoom(24 + block.lines.length * 14);
        page.drawLine({ start: { x: MARGIN, y: y }, end: { x: MARGIN + 160, y: y }, thickness: 0.75, color: LINE_GRAY });
        y -= 16;
        block.lines.forEach(function (l, idx) {
          ensureRoom(16);
          const f = idx === 0 ? bold : font;
          const c = idx === 0 ? NAVY : GRAY;
          const size = idx === 0 ? 11 : 9.5;
          page.drawText(l, { x: MARGIN, y: y - size, size: size, font: f, color: c });
          y -= (idx === 0 ? 17 : 14);
        });
        continue;
      }
      if (block.type === "para") {
        ensureRoom(18);
        for (const w of wrapText(block.text, font, 10.5, CONTENT_W)) {
          ensureRoom(16);
          page.drawText(w, { x: MARGIN, y: y - 10.5, size: 10.5, font: font, color: INK });
          y -= 15.5;
        }
        continue;
      }
      if (block.type === "table") {
        const rowH = 22;
        const labelColW = 190;
        ensureRoom(rowH + 10);
        y -= 4;
        const tableTop = y;
        let rowY = y;
        block.rows.forEach(function (r, idx) {
          if (rowY - rowH < MARGIN + 40) {
            page.drawLine({ start: { x: MARGIN, y: rowY }, end: { x: PAGE_W - MARGIN, y: rowY }, thickness: 0.75, color: LINE_GRAY });
            newPage();
            rowY = y;
          }
          if (idx % 2 === 1) {
            page.drawRectangle({ x: MARGIN, y: rowY - rowH, width: CONTENT_W, height: rowH, color: ROW_TINT });
          }
          page.drawText(r.label, { x: MARGIN + 10, y: rowY - rowH / 2 - 4, size: 9.5, font: font, color: NAVY_SOFT });
          const valLines = wrapText(r.value, bold, 10.5, CONTENT_W - labelColW - 10);
          page.drawText(valLines[0], { x: MARGIN + labelColW, y: rowY - rowH / 2 - 4, size: 10.5, font: bold, color: INK });
          rowY -= rowH;
        });
        page.drawLine({ start: { x: MARGIN, y: rowY }, end: { x: PAGE_W - MARGIN, y: rowY }, thickness: 0.75, color: LINE_GRAY });
        page.drawRectangle({ x: MARGIN, y: rowY, width: CONTENT_W, height: tableTop - rowY, borderColor: LINE_GRAY, borderWidth: 0.75, color: undefined, opacity: 0 });
        y = rowY - 12;
        continue;
      }
    }
    drawFooter(page);

    const pdfBytes = await pdfDoc.save();
    const pdfBase64 = bytesToBase64(pdfBytes);

    return new Response(JSON.stringify({ ok: true, pdfBase64 }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
