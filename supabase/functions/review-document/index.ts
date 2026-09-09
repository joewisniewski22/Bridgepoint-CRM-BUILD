// Real AI document review: downloads the just-uploaded file from the
// "lead-documents" storage bucket and asks Claude (vision-capable) to
// actually look at it -- not the old deterministic mock in index.html's
// AI_DOC_FINDINGS. Runs automatically right after every upload (borrower
// portal or staff) so nothing sits unreviewed waiting on a manual click.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = "claude-haiku-4-5-20251001";
const BUCKET = "lead-documents";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const DOC_GUIDANCE: Record<string, string> = {
  "Government ID": "Check the name, date of birth, and expiration date are legible and not expired. Flag if the name doesn't clearly match the borrower name given below, or if it's expired.",
  "Bank Statements (2mo)": "Check the account holder name matches the borrower, the statement is recent (within ~60 days), and balances look consistent across pages. Flag large unexplained deposits or an outdated statement.",
  "Purchase Contract": "Check the purchase price and property address match what's given below, and that it's signed and dated by all parties. Flag any missing signature/date or a price mismatch.",
  "Entity Docs (Operating Agreement)": "Check the entity name and formation state are clear and an authorized signer is named. Flag if no authorized signer is identifiable.",
  "Appraisal": "Check the appraised value supports the loan amount and LTV given below. Flag if the appraised value looks like it came in below what the loan assumes.",
  "Insurance Binder": "Check the coverage amount and effective dates look sufficient for the loan amount given below. Flag if coverage looks lower than the loan amount or dates don't cover closing.",
  // Constructive Capital's RTL Foreign Nationals appendix (Appendix E, 2.1.26).
  "Foreign National Passport": "Check it's a passport (not a national ID or driver's license), the photo page is legible, and the expiration date is clearly in the future (not expired). Flag if expired, illegible, or if the document is not actually a passport.",
  "Foreign National Visa / USCIS Approval": "This should be an I-797 Notice of Action, a visa stamp/page in the passport, or a USCIS approval letter showing a valid, unexpired visa classification. Flag if expired, illegible, or if no visa class is identifiable on the document.",
  "Foreign National Liquidity Verification": "Check this shows funds on deposit at a U.S. (FDIC-insured) banking institution, seasoned at least 60 days -- statement dates should span 2+ months. Flag if the institution isn't clearly U.S.-based, if seasoning can't be confirmed from the dates shown, or if the balance looks inconsistent across statements.",
  "Registered Agent Confirmation": "Check it names a registered agent (a company, attorney, or individual) for the borrowing entity in the state(s) where it's qualified to do business. Flag if no registered agent is named or the entity/state isn't identifiable.",
  "Entity Ownership Schedule (Foreign National)": "Check the ownership schedule accounts for every owner/guarantor and their percentage. Flag if more than 2 Foreign Nationals are guarantors or hold 20%+ ownership, if any owner is itself an entity (not a natural person), or if ownership percentages don't add up to 100%.",
};
const DEFAULT_GUIDANCE = "Check the document looks complete, legible, and consistent with the loan details given below. Flag any illegible sections, missing pages, or obvious inconsistencies.";

function corsJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return corsJson({ error: "method_not_allowed" }, 405);

  try {
    const body = await req.json();
    const path: string = body.path;
    const docName: string = body.docName || "Document";
    const context = body.context || {};
    if (!path) return corsJson({ error: "missing_path" }, 400);

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: fileBlob, error: dlError } = await sb.storage.from(BUCKET).download(path);
    if (dlError || !fileBlob) {
      return corsJson({ ok: true, status: "flag", note: "Couldn't retrieve the uploaded file to review automatically — please check it manually." });
    }

    const contentType = fileBlob.type || "application/octet-stream";
    const bytes = new Uint8Array(await fileBlob.arrayBuffer());
    // Cap at ~18MB (Anthropic's request-size ceiling has headroom above the
    // 10MB image / 32MB PDF limits, but very large files aren't realistic
    // for these document types and we'd rather flag than time out).
    if (bytes.length > 18 * 1024 * 1024) {
      return corsJson({ ok: true, status: "flag", note: "File is larger than expected for this document type — please review manually." });
    }
    const b64 = base64FromBytes(bytes);

    let contentBlock: Record<string, unknown> | null = null;
    if (contentType.startsWith("image/")) {
      contentBlock = { type: "image", source: { type: "base64", media_type: contentType, data: b64 } };
    } else if (contentType === "application/pdf" || path.toLowerCase().endsWith(".pdf")) {
      contentBlock = { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } };
    } else {
      return corsJson({ ok: true, status: "flag", note: "This file type (" + contentType + ") can't be automatically reviewed yet — please check it manually." });
    }

    const guidance = DOC_GUIDANCE[docName] || DEFAULT_GUIDANCE;
    const isForeignNational = context.citizenshipStatus === "Foreign National";
    const fnNote = isForeignNational
      ? "\n\nFOREIGN NATIONAL FILE: this borrower/guarantor is a Foreign National (not a US citizen, permanent resident, or authorized to work in the US). Per BPL's Foreign Nationals guidelines: on a Government-Issued Photo ID, a foreign passport is acceptable and expected -- do not flag it as wrong just for not being a US-issued ID. On bank statements, funds must be at a U.S. (FDIC-insured) institution seasoned 60+ days -- flag if the institution or seasoning can't be confirmed. On entity/ownership documents, flag if more than 2 Foreign Nationals appear as guarantors or 20%+ owners, or if any owner is itself an entity rather than a natural person."
      : "";
    const promptText = "You are reviewing a loan document for a hard-money/DSCR real estate lender.\n\n" +
      "IMPORTANT CONTEXT: this lender only makes business-purpose loans to investment entities on non-owner-occupied property -- the borrower/guarantor never lives at the subject property. Their government ID, EIN letter, entity documents, and bank statements will almost always show a personal or business mailing address that's completely different from the property address below. That is normal and expected for every single file -- NEVER flag an address on the borrower's ID, entity docs, or EIN letter as inconsistent just because it doesn't match the property address. Only flag address-related issues within a document type where that document's own guidance below explicitly calls for an address check (e.g. a purchase contract's address should match the property)." + fnNote + "\n\n" +
      "Document type: " + docName + "\n" +
      "What to check: " + guidance + "\n\n" +
      "Loan file details:\n" +
      "- Borrower: " + (context.borrowerName || "unknown") + "\n" +
      "- Loan type: " + (context.loanType || "unknown") + "\n" +
      "- Loan amount: " + (context.loanAmount || "unknown") + "\n" +
      "- Property address: " + (context.propertyAddress || "unknown") + "\n" +
      (context.ltv ? ("- LTV: " + context.ltv + "%\n") : "") +
      "\nLook at the actual document above and respond with ONLY a JSON object (no markdown fences, no commentary) with exactly these keys:\n" +
      '{"status": "clear" or "flag", "note": "one or two specific sentences explaining what you found"}\n' +
      "Use \"flag\" if anything above needs a human's attention before this file can move forward; use \"clear\" only if the document genuinely looks complete and consistent.";

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: "You are a precise loan-document review assistant. Output ONLY valid JSON matching exactly what's requested -- no markdown code fences, no commentary, no preamble.",
        messages: [{ role: "user", content: [contentBlock, { type: "text", text: promptText }] }],
      }),
    });
    const aiData = await aiRes.json();
    if (!aiRes.ok) {
      console.log("review-document: anthropic_error", JSON.stringify(aiData));
      return corsJson({ ok: true, status: "flag", note: "Automatic review couldn't complete — please check this document manually." });
    }

    const raw = (aiData.content && aiData.content[0] && aiData.content[0].text) || "";
    let parsed: { status?: string; note?: string } = {};
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch (_e) {
      return corsJson({ ok: true, status: "flag", note: "Automatic review returned an unexpected response — please check this document manually." });
    }
    const status = parsed.status === "clear" ? "clear" : "flag";
    const note = (parsed.note || "Reviewed — no further detail returned.").toString().slice(0, 500);
    return corsJson({ ok: true, status, note });
  } catch (err) {
    console.log("review-document: server_error", String(err));
    return corsJson({ ok: true, status: "flag", note: "Automatic review hit an error — please check this document manually." });
  }
});
