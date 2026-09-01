// Renders a plain-text loan document (Pre-Approval Letter, Term Sheet) that
// the CRM already builds client-side into a real, letterhead-branded PDF.
// Pure renderer -- the frontend remains the single source of truth for the
// document's wording/bilingual content; this just typesets it.
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
const FONT_SIZE = 10.5;
const LINE_HEIGHT = 15;

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

    let logoImg = null;
    let logoDims: { width: number; height: number } | null = null;
    try {
      const logoRes = await fetch(LOGO_URL);
      if (logoRes.ok) {
        const logoBytes = new Uint8Array(await logoRes.arrayBuffer());
        logoImg = await pdfDoc.embedJpg(logoBytes);
        const scale = Math.min(1, 150 / logoImg.width);
        logoDims = logoImg.scale(scale);
      }
    } catch (_e) {
      // Logo is a nice-to-have; never fail the whole PDF over it.
    }

    const contentWidth = PAGE_W - MARGIN * 2;
    let page: PDFPage = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MARGIN;

    if (logoImg && logoDims) {
      page.drawImage(logoImg, { x: MARGIN, y: y - logoDims.height, width: logoDims.width, height: logoDims.height });
      y -= logoDims.height + 20;
    }

    function ensureRoom() {
      if (y < MARGIN + LINE_HEIGHT) {
        page = pdfDoc.addPage([PAGE_W, PAGE_H]);
        y = PAGE_H - MARGIN;
      }
    }

    for (const raw of text.split("\n")) {
      const isHeading = raw.trim().length > 0 && raw === raw.toUpperCase() && /[A-Z]/.test(raw);
      const useFont = isHeading ? bold : font;
      for (const w of wrapText(raw, useFont, FONT_SIZE, contentWidth)) {
        ensureRoom();
        page.drawText(w, { x: MARGIN, y: y - FONT_SIZE, size: FONT_SIZE, font: useFont, color: rgb(0.11, 0.1, 0.08) });
        y -= LINE_HEIGHT;
      }
    }

    const pdfBytes = await pdfDoc.save();
    const pdfBase64 = bytesToBase64(pdfBytes);

    return new Response(JSON.stringify({ ok: true, pdfBase64 }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
