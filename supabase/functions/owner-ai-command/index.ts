// AI command box, available to every staff member. Joe types a
// plain-English request in his portal; Claude decides which of a small,
// fixed set of real backend tools to call (look up closed deals, draft/
// publish marketing content to the CRM's own public showcase page, manage
// loan files) and reports back what it actually did. Owner-only tools
// (marketing/public site, team-wide broadcasts, engagement/growth/pricing
// levers) and non-owner scoping to the caller's own leads are enforced
// server-side -- see OWNER_ONLY_TOOLS and resolveCaller() below.
// CRM-native by design -- this whole CRM build is meant to eventually
// replace GoHighLevel (which currently runs bplending.com), not deepen
// the dependency on it. Deliberately narrow tool surface -- no arbitrary
// code/SQL execution, no ad-spend or payment tools yet (those get added
// only once those integrations are actually connected). Never claims an
// action succeeded unless the corresponding tool call reported success.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const MODEL = "claude-sonnet-5";

// Real per-caller authorization. Everyone gets the assistant now (Joe:
// "the only restriction they should have is system wide changes ... they
// should all be able to give it commands to update files etc") -- so a
// non-owner caller may use lead-scoped tools ONLY against leads assigned
// to them, and may never touch the owner-only tools below (marketing to
// the public site, team-wide broadcasts, and business-wide engagement/
// growth/pricing levers that affect every LO at once). Caller identity is
// resolved server-side from the real Supabase Auth JWT on the request --
// see resolveCaller() -- never trusted from a client-supplied field.
type Caller = { id: string; name: string; role: string; isOwner: boolean };
const OWNER_ONLY_TOOLS = new Set([
  "list_closed_deals", "list_content_drafts", "create_content", "publish_content",
  "email_team", "text_team",
  "analyze_engagement_performance", "apply_engagement_adjustment",
  "analyze_growth_progress", "update_growth_goal", "analyze_pricing_competitiveness",
]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const LOAN_TYPES = ["DSCR", "Fix & Flip", "Ground Up Construction", "Portfolio/Blanket", "Bridge", "Mixed-Use"];
const SOURCES = ["Meta Ads", "Connected Investors", "Referral", "Repeat Client", "Website", "Self-Generated"];
const OUTSIDE_LENDERS = ["Kiavi", "RELIP", "RCN"];
const CITIZENSHIP_STATUSES = ["US Citizen", "Permanent Resident", "Foreign National", "ITIN"];
const PREPAY_TERMS = ["5yr", "3yr", "2yr", "1yr", "none"];

async function buildSystemPrompt(caller: Caller, businessSnapshot: Record<string, unknown> | null): Promise<string> {
  const { data: staff } = await sb.from("users").select("id,name,role").order("name");
  const roster = (staff || []).map((u) => u.id + " = " + u.name + " (" + u.role + ")").join("; ");
  const callerLine = caller.isOwner
    ? "You are talking to " + caller.name + " (owner), who has full access to every tool below.\n\n"
    : "You are talking to " + caller.name + " (" + caller.role + ", id " + caller.id + "), NOT the owner. " +
      "They can manage their own loan files (create/update/search/view leads assigned to them, add notes, reassign leads currently assigned to them, send documents, run a retargeting campaign against their own leads) but CANNOT do anything company-wide: no marketing content to the public site, no team-wide email/text broadcasts, and no engagement/growth/pricing-strategy tools -- those are owner-only, no matter how they phrase the request. If they ask for one of those, tell them plainly it's owner-only rather than attempting it. Every lead-scoped tool call you make is re-checked server-side against leads actually assigned to them, so never try to act on someone else's lead on their behalf -- tell them to ask the owner or that LO instead.\n\n";
  return callerLine + "You are Joe's AI operations assistant for Bridgepoint Lending, embedded in his CRM. " +
    "This CRM is meant to eventually replace GoHighLevel entirely (which currently runs bplending.com) -- content you publish lives on the CRM's public page, not GoHighLevel. " +
    "You do NOT yet have access to ad platforms (Meta/Facebook), payments, or pricing changes -- if asked for something outside your current tools, say clearly that it isn't wired up yet rather than pretending to do it. " +
    "\n\nStaff roster (use these exact ids for assignedTo, never guess an id): " + roster +
    "\n\nCAPABILITIES:\n" +
    "1. Marketing content: create_content then publish_content to post recent-closing announcements or stories to the CRM's public showcase page. Never claim something is live unless publish_content reports success. Default to NOT naming the borrower and NOT including their exact street address (city/state only) unless Joe explicitly asks -- these are real clients' financial details. Write body as simple HTML (p, strong, br, a tags only).\n" +
    "2. Loan file creation from a term sheet: when Joe pastes term sheet text or attaches a term sheet document/image for a BRAND NEW loan (not already in the CRM), extract the real figures and call create_loan_file. Valid loanType values: " + LOAN_TYPES.join(", ") + ". Valid source values: " + SOURCES.join(", ") + " (use 'Referral' or the closest fit if unclear, never invent a new source). Valid outsideLender values: " + OUTSIDE_LENDERS.join(", ") + " or omit for in-house. NEVER guess a figure that isn't actually in the document -- omit any field you can't find rather than inventing a number, and tell Joe what's missing in your reply. If the assignee isn't stated, ASK rather than picking someone.\n" +
    "3. Updating an EXISTING loan file: when Joe gets a new/real quote back (e.g. a lender's pricing terms sheet) for a loan already in the CRM, call update_loan_file with the leadId and only the fields that changed -- extract real figures the same way as create_loan_file, never guess. This updates BOTH the loan scenario/pricing AND, for DSCR loans, the loan product name on the actual application (via loanProduct) -- our generated term sheet, the borrower portal, and the application all read from these same fields, so one call keeps everything in sync. If Joe doesn't give you the leadId, use search_leads with the borrower's name/phone/email first rather than asking him for it. Always write a one-sentence changeSummary describing what changed and why (e.g. citing a pricing/quote ID if the source document has one) -- it gets logged to the loan's activity history.\n" +
    "4. Sending documents: to send a Pre-Approval Letter or Term Sheet to a borrower on an existing loan file, call send_document with the leadId and kind -- this actually emails/texts them for real, so only call it when Joe clearly asks to send (not just when he asks you to create or update a file).\n" +
    "5. Looking up loans: list_closed_deals for recently funded loans, or search_leads / get_lead_details to find and inspect any loan file by name/phone/email or id.\n" +
    "6. Team communication: email_team and text_team send a REAL email/text to staff -- team-wide announcements, reminders, or a message to one specific person. Only call these when Joe clearly asks you to send/tell/email/text someone or the team, not as a side effect of something else.\n" +
    "7. reassign_lead to change who a loan file is assigned to. add_lead_note to log a note on a loan file's activity history.\n" +
    "8. Retargeting campaigns: start_retargeting_campaign drafts a personalized email/text batch send to a group of existing leads. Target them by assignedTo (e.g. 'all of Taeya's leads'), specific leadIds, or noContactDays (e.g. 'anyone with no contact in 30 days' -> noContactDays: 30, computed from real call attempts and logged call/text/email activity, never guessed) -- these can combine, e.g. assignedTo + noContactDays for 'Taeya's leads that have gone quiet for 30 days'. Write genuinely good, specific copy yourself -- introduce the LO by name as the borrower's real point of contact, reference their loan interest when known (via {{loanTypeLine}}), and drive toward booking a call ({{bookingLink}}) or calling/texting the LO directly ({{loPhone}}). Keep texts SMS-short. This never sends anything itself -- it resolves the real recipient list and returns a preview for Joe to review and confirm in the CRM.\n" +
    "9. Learning from real performance: when Joe asks you to 'look at engagement' or 'look and adjust' (he does not want to track this himself), this is ALWAYS a two-tool-call task, never one. Step 1: call analyze_engagement_performance. Step 2, in that same turn after seeing the results: you must do exactly one of (a) call apply_engagement_adjustment for real, or (b) write your reply stating plainly that nothing in the data supports a change. There is no third option -- never write a reply that describes, summarizes, or claims a specific adjustment (a guidance change, a cadence change) as something you did unless that exact apply_engagement_adjustment tool call is present in this turn's actions. If you're weighing whether to make a change, resolve that by calling the tool or by concluding no -- never resolve it by narrating an intention. Weight changes to how thin the data is, and say so plainly rather than overclaiming a pattern from a handful of leads. Always cite the actual numbers.\n" +
    "10. Growth advising: Joe wants ongoing, business-manager-style guidance toward a real funded-volume goal (call analyze_growth_progress for the current target/deadline/pace, real pipeline/lead/revenue numbers, AND its perLoanOfficer breakdown -- never assume the goal, always look it up fresh). For a capacity-planning question like 'how do I get to 30 loans this month with the employees I have', combine analyze_growth_progress's perLoanOfficer pace (closed + active pipeline per LO) with analyze_lo_speed_to_lead's missed-leads report (real slack capacity being left on the table per LO) -- reason concretely from both: whether the shortfall is a lead-volume problem, a per-LO conversion/speed problem, or genuinely needs another hire, citing the actual numbers rather than a generic pep talk. Ground spend/channel recommendations in real revenue (points-based revenue on the active pipeline and any closed volume -- or the REAL-TIME REVENUE SNAPSHOT for YSP-inclusive totals) so a recommendation like 'increase Facebook spend' is actually affordable, not just a lead-volume guess -- his own words: 'you'll know my budget because you should see earnings based on what we already built.' If he tells you a goal, deadline, or baseline changed (ad spend, CIX volume, a month hit the target), call update_growth_goal for real, same discipline as tool 9 -- narrating it isn't enough. For pricing/rate competitiveness questions, call analyze_pricing_competitiveness -- there is no external competitor-rate feed, so frame guidance around Bridgepoint's own margin over its real wholesale par rate, and say explicitly that you don't have live competitor pricing if asked to compare against a specific competitor.\n\n" +
    "You still do NOT have: ad platform access, payments/spend, or any destructive/irreversible action (no deleting files, no changing pricing/guidelines). If asked for one of those, say plainly it isn't wired up rather than pretending.\n\n" +
    "Keep replies concise -- confirm what you actually did (per tool results), don't over-explain. If a tool result shows an error, say so plainly rather than claiming success. " +
    "CRITICAL: never describe an action (sent, triggered, created, updated, published) as done unless you actually called that exact tool THIS turn and its result confirmed success -- don't narrate an effect from context, from what Joe asked for, or from a tool you called for a different purpose. If you only updated a file and didn't call send_document, do not say anything was sent or triggered -- say what you'd need to do that as a separate, explicit step instead.\n\n" +
    "IMPORTANT -- new tools get added to you over time, so an earlier message in THIS conversation (including something you yourself said in a past reply) claiming you can't do something may now be stale and wrong. Before telling Joe you lack a capability, re-check the actual tool list and each tool's real parameters above right now -- never rely on what you or he said about your capabilities earlier in this thread. In particular: start_retargeting_campaign's noContactDays parameter ALREADY resolves 'everyone/anyone with no contact in N days' into real lead ids itself -- you do NOT need a separate lookup tool for that, don't claim you're missing one." +
    (businessSnapshot ? (
      "\n\nREAL-TIME REVENUE SNAPSHOT (computed just now by the app's own live pricer, scope: " + String(businessSnapshot.scope) + " -- this is the authoritative source for ANY points/YSP/yield-spread/commission question, more precise than analyze_growth_progress's own revenue field, which is points-only and deliberately excludes YSP to avoid a second, drift-prone copy of the DSCR pricing engine living server-side. Use these numbers directly rather than calling a tool for them):\n" +
      "Closed this month -- " + (businessSnapshot.closedThisMonth as Record<string, unknown>).loanCount + " loan(s): $" + fmtUSD((businessSnapshot.closedThisMonth as Record<string, unknown>).pointsRevenue as number) + " points + $" + fmtUSD((businessSnapshot.closedThisMonth as Record<string, unknown>).yspRevenue as number) + " YSP = $" + fmtUSD((businessSnapshot.closedThisMonth as Record<string, unknown>).totalRevenue as number) + " total.\n" +
      "Active pipeline (potential, not yet earned) -- " + (businessSnapshot.activePipeline as Record<string, unknown>).loanCount + " loan(s): $" + fmtUSD((businessSnapshot.activePipeline as Record<string, unknown>).pointsRevenue as number) + " points + $" + fmtUSD((businessSnapshot.activePipeline as Record<string, unknown>).yspRevenue as number) + " YSP = $" + fmtUSD((businessSnapshot.activePipeline as Record<string, unknown>).totalRevenue as number) + " potential total."
    ) : "");
}

const TOOLS = [
  {
    name: "list_closed_deals",
    description: "Look up recently closed/funded loans to reference in marketing content.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "integer", description: "Max results, default 5" } },
    },
  },
  {
    name: "list_content_drafts",
    description: "List existing site content (recent closings / stories) and their status.",
    input_schema: {
      type: "object",
      properties: { status: { type: "string", enum: ["draft", "published", "publish_failed", "all"], description: "Filter by status, default all" } },
    },
  },
  {
    name: "create_content",
    description: "Create a new piece of marketing content as a draft (not yet live). Follow with publish_content to actually push it to the website.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["closing", "story"] },
        leadId: { type: "string", description: "Related loan file id, if any" },
        title: { type: "string" },
        body: { type: "string", description: "Simple HTML content (p, strong, br, a tags only)" },
      },
      required: ["type", "title", "body"],
    },
  },
  {
    name: "publish_content",
    description: "Publish a draft content item live to the CRM's public showcase page (bridgepoint-crm-build.vercel.app/?showcase=1).",
    input_schema: {
      type: "object",
      properties: { contentId: { type: "string" } },
      required: ["contentId"],
    },
  },
  {
    name: "create_loan_file",
    description: "Create a new loan file from a term sheet Joe pasted or attached. Only include fields you actually found -- omit anything not clearly stated.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Borrower/guarantor full name" },
        email: { type: "string" },
        phone: { type: "string" },
        loanType: { type: "string", enum: LOAN_TYPES },
        source: { type: "string", enum: SOURCES },
        assignedTo: { type: "string", description: "Staff user id from the roster" },
        outsideLender: { type: "string", enum: OUTSIDE_LENDERS, description: "Omit if in-house" },
        propertyAddress: { type: "string" },
        propertyType: { type: "string" },
        purchasePrice: { type: "number" },
        loanAmount: { type: "number" },
        rate: { type: "number", description: "Interest rate as a percent, e.g. 10.99" },
        termMonths: { type: "integer" },
        pointsCharged: { type: "number", description: "Total points as a percent, e.g. 4.44" },
        creditScore: { type: "integer" },
        entityLegalName: { type: "string" },
        exitStrategy: { type: "string" },
        notifyAssignee: { type: "boolean", description: "Whether to email the assigned staff member about this new file (default true)" },
      },
      required: ["name", "loanType"],
    },
  },
  {
    name: "update_loan_file",
    description: "Update fields on an EXISTING loan file already in the CRM -- e.g. after Joe gets a real quote/pricing terms sheet back for a loan. Only include fields you actually found in the new document; anything omitted is left untouched.",
    input_schema: {
      type: "object",
      properties: {
        leadId: { type: "string", description: "The loan file id to update -- ask Joe for this if he hasn't given it" },
        propertyAddress: { type: "string" },
        propertyType: { type: "string" },
        transactionType: { type: "string", enum: ["purchase", "ratetermrefi", "cashout"] },
        purchasePrice: { type: "number" },
        currentValue: { type: "number", description: "As-is value -- used instead of purchase price for refinance LTV" },
        arv: { type: "number", description: "After-repair value, for rehab/construction loans" },
        rehabBudget: { type: "number" },
        rentEstimate: { type: "number", description: "Monthly rental income, for DSCR loans" },
        monthlyTaxes: { type: "number" },
        monthlyInsurance: { type: "number" },
        monthlyHoa: { type: "number" },
        loanAmount: { type: "number" },
        rate: { type: "number", description: "Interest rate as a percent, e.g. 6.975" },
        termMonths: { type: "integer" },
        pointsCharged: { type: "number", description: "Total points Bridgepoint is actually charging, as a percent -- use what Joe tells you to charge, not necessarily whatever number is printed on an outside quote" },
        creditScore: { type: "integer" },
        prepayTerm: { type: "string", enum: PREPAY_TERMS },
        loanProduct: { type: "string", description: "DSCR loans only -- the actual loan product/amortization named on the term sheet, e.g. '30 Year Fixed', '5/1 ARM', 'Interest Only'. Merged into the application, not just the pricing." },
        citizenshipStatus: { type: "string", enum: CITIZENSHIP_STATUSES },
        exitStrategy: { type: "string" },
        changeSummary: { type: "string", description: "One short sentence for the activity log describing what changed and why (cite a pricing/quote ID from the source document if there is one)" },
        notifyAssignee: { type: "boolean", description: "Whether to text/email the assigned loan officer that terms changed (default true)" },
      },
      required: ["leadId"],
    },
  },
  {
    name: "search_leads",
    description: "Find loan file(s) by borrower name, phone, or email -- returns matching ids so you can then use get_lead_details, update_loan_file, reassign_lead, etc.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Name, phone, or email to search for" } },
      required: ["query"],
    },
  },
  {
    name: "get_lead_details",
    description: "Get full details of one loan file by its id.",
    input_schema: {
      type: "object",
      properties: { leadId: { type: "string" } },
      required: ["leadId"],
    },
  },
  {
    name: "reassign_lead",
    description: "Change which staff member a loan file is assigned to.",
    input_schema: {
      type: "object",
      properties: {
        leadId: { type: "string" },
        assignedTo: { type: "string", description: "Staff user id from the roster" },
      },
      required: ["leadId", "assignedTo"],
    },
  },
  {
    name: "add_lead_note",
    description: "Log a note on a loan file's activity history.",
    input_schema: {
      type: "object",
      properties: {
        leadId: { type: "string" },
        note: { type: "string" },
      },
      required: ["leadId", "note"],
    },
  },
  {
    name: "email_team",
    description: "Prepare a real email to some or all staff members -- announcements, reminders, or a message to one specific person. Does not send immediately -- Joe reviews and confirms in the CRM before it actually goes out, same as document sends.",
    input_schema: {
      type: "object",
      properties: {
        recipients: { type: "string", enum: ["all_staff", "loan_officers", "processors", "specific"], description: "Who to send to. Use 'specific' with staffIds for one or a few people." },
        staffIds: { type: "array", items: { type: "string" }, description: "Required when recipients is 'specific' -- staff user ids from the roster" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text email body" },
      },
      required: ["recipients", "subject", "body"],
    },
  },
  {
    name: "text_team",
    description: "Prepare a real text message to some or all staff members. Keep it short, SMS-appropriate. Does not send immediately -- Joe reviews and confirms in the CRM before it actually goes out, same as document sends.",
    input_schema: {
      type: "object",
      properties: {
        recipients: { type: "string", enum: ["all_staff", "loan_officers", "processors", "specific"], description: "Who to send to. Use 'specific' with staffIds for one or a few people." },
        staffIds: { type: "array", items: { type: "string" }, description: "Required when recipients is 'specific' -- staff user ids from the roster" },
        text: { type: "string" },
      },
      required: ["recipients", "text"],
    },
  },
  {
    name: "send_document",
    description: "Send a Pre-Approval Letter or Term Sheet to a borrower on an existing loan file -- real email + text. Only call this when Joe explicitly asks to send something, not when just creating a file.",
    input_schema: {
      type: "object",
      properties: {
        leadId: { type: "string" },
        kind: { type: "string", enum: ["preapproval", "termSheet"] },
      },
      required: ["leadId", "kind"],
    },
  },
  {
    name: "start_retargeting_campaign",
    description: "Draft a personalized email + text retargeting campaign to a batch of existing leads, aimed at getting them on the phone with their assigned loan officer. Targets a real, server-resolved recipient list -- you do NOT need any other tool to first look up which leads qualify. Three ways to target, combinable: assignedTo (one LO's whole book), leadIds (a specific list), or noContactDays (every active lead untouched for at least N days -- THIS is the tool for 'anyone/everyone with no contact in N days', resolved from real call/text/email activity, no separate lookup tool exists or is needed). Write real, specific, warm copy yourself (not generic marketing filler) using merge fields -- this does NOT send anything itself. It resolves the real recipient list server-side and returns requiresFrontendAction: review_campaign; Joe previews it in the CRM and must click Send before anything actually goes out, same as email_team/text_team.",
    input_schema: {
      type: "object",
      properties: {
        assignedTo: { type: "string", description: "Staff id to target every one of their active leads (use this for 'all of X's leads'). Can be combined with noContactDays to scope staleness to one LO." },
        leadIds: { type: "array", items: { type: "string" }, description: "Specific lead ids to target, instead of assignedTo" },
        noContactDays: { type: "integer", description: "Instead of (or combined with) assignedTo/leadIds: target every active lead with no logged human contact (call, text, or email) in at least this many days -- e.g. 'anyone with no contact in 30 days' -> 30. Company-wide for the owner unless assignedTo also narrows it to one LO; always scoped to the caller's own leads for non-owners." },
        channel: { type: "string", enum: ["email", "text", "both"] },
        emailSubject: { type: "string", description: "Required if channel includes email" },
        emailBodyTemplate: { type: "string", description: "Email body as PLAIN TEXT -- use real newline characters (\\n) for line breaks, never HTML tags like <br>, the send pipeline converts newlines to HTML itself. Merge fields: {{firstName}} {{loName}} {{loPhone}} {{loanTypeLine}} (a COMPLETE standalone sentence about their specific loan interest, or a complete generic sentence if unknown -- always ends in a period, so surrounding text must not run another sentence into it) {{bookingLink}} (in the EMAIL version this becomes a real clickable word 'HERE', e.g. write '...grab a time that works for you {{bookingLink}}.' which renders as '...grab a time that works for you HERE.' with HERE as the link -- don't also print a raw URL)." },
        textBodyTemplate: { type: "string", description: "SMS body, keep it short (under ~300 chars). Same merge fields, except {{bookingLink}} in a text renders as the literal URL (SMS can't do custom link text) -- write it naturally as a URL, e.g. '...book a time here: {{bookingLink}}'." },
      },
      required: ["channel", "emailSubject", "emailBodyTemplate", "textBodyTemplate"],
    },
  },
  {
    name: "analyze_engagement_performance",
    description: "Pull real conversion data across all leads that went through the automated AI texting engagement or the manual call cadence -- reply rates, conversion to application/booked call, opt-out rate, time-to-first-contact, and recent coaching notes. Use this before recommending or applying any adjustment via apply_engagement_adjustment -- never adjust based on a guess. With a young or small dataset, say so plainly and recommend smaller/more cautious changes (or none yet) rather than overclaiming a pattern from a handful of leads.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "analyze_lo_speed_to_lead",
    description: "Per-loan-officer report on REAL HUMAN speed-to-lead and missed leads -- excludes anything the AI did automatically, since the AI can text/email instantly and that's not a measure of the LO's own behavior. Calls are always human (the AI never dials), and are timed precisely from lead creation to first call. Texts/emails only count if explicitly staff-initiated (not the AI texting/emailing under the LO's name) and are only date-precise, not time-of-day -- and that distinction only exists for messages sent after this tool was built, so older texts/emails can't be retroactively classified and are excluded from the text/email side of the report (calls are unaffected by this, they were always trackable). Use this for 'who's missing leads' / 'how fast is X calling' / 'income left on the table' questions -- don't estimate this by eyeballing lead files.",
    input_schema: {
      type: "object",
      properties: {
        assignedTo: { type: "string", description: "Staff id to report on just one LO. Omit for every LO." },
        missedThresholdHours: { type: "integer", description: "Hours since lead creation with zero human contact before it counts as 'missed' / fell through the cracks. Default 48." },
      },
      required: [],
    },
  },
  {
    name: "apply_engagement_adjustment",
    description: "Update the live-tunable engagement settings that the automated AI texting (ai-lead-engage) and follow-up cadence actually read at runtime -- no code deploy needed, takes effect on the next message. Only call this after analyze_engagement_performance, and only change what the data actually supports. Joe wants to be able to just say 'look at engagement and adjust' -- apply sensible, data-backed changes directly rather than asking him to approve each one; just always explain what changed and why in your reply.",
    input_schema: {
      type: "object",
      properties: {
        cadenceMax: { type: "integer", description: "Max follow-up attempts before a lead auto-marks cold. Change conservatively -- e.g. by 1-2, not wild swings." },
        messagingGuidance: { type: "string", description: "Extra steering text appended to the AI texting system prompt on every conversation, e.g. a specific phrasing or approach that's shown better reply/conversion rates. Replaces whatever guidance is currently set -- if there's existing guidance worth keeping, include it plus your addition, don't just append blindly since you don't know the full current context." },
        reason: { type: "string", description: "What data supports this change -- cite actual numbers from analyze_engagement_performance. Required." },
      },
      required: ["reason"],
    },
  },
  {
    name: "analyze_growth_progress",
    description: "Pull the real growth goal (target monthly funded volume, deadline, consecutive-months requirement) plus actual current pipeline data: leads this month by source (CIX vs Facebook vs self-generated vs referral), pipeline stage breakdown, real average loan size, and funded volume this month. Use this whenever Joe asks how the business is tracking toward the goal, or asks for spend/channel recommendations ('like a business manager'). Always ground recommendations in the real numbers this returns, not assumptions -- if funded volume is $0 or data is thin, say so plainly.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "update_growth_goal",
    description: "Update the growth goal record -- target amount, deadline, consecutive-months requirement, or the known lead-source baselines (cixLeadsPerMonth, dailyFbSpend) when Joe tells you those changed (e.g. he raised ad spend, or CIX volume changed). Also use this to log consecutiveMonthsHit when a target month is confirmed funded.",
    input_schema: {
      type: "object",
      properties: {
        currentTargetMonthly: { type: "number" },
        consecutiveMonthsRequired: { type: "integer" },
        consecutiveMonthsHit: { type: "integer" },
        nextTargetMonthly: { type: "number" },
        targetDeadlineMonths: { type: "integer" },
        cixLeadsPerMonth: { type: "integer" },
        dailyFbSpend: { type: "number" },
        notes: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "analyze_pricing_competitiveness",
    description: "Compare Bridgepoint's actual charged rates/points against the current wholesale par rates (market_rates table) by loan type, using real active and closed loan files. This shows Bridgepoint's own margin/yield-spread on real deals -- there is NO external competitor-rate data feed, so never claim to know a competitor's or 'the industry's' actual current pricing; frame guidance around par-rate margin and general market-rate-shift context only, and say so explicitly if asked to compare to a specific competitor.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

function fmtUSD(n: number | null): string | null {
  if (n == null) return null;
  return "$" + Math.round(n).toLocaleString("en-US");
}

async function runTool(name: string, input: Record<string, unknown>, caller: Caller): Promise<unknown> {
  if (OWNER_ONLY_TOOLS.has(name) && !caller.isOwner) {
    return { error: "not_authorized", detail: "This is an owner-only action -- only Joe can do this." };
  }
  if (name === "list_closed_deals") {
    const limit = Math.min((input.limit as number) || 5, 20);
    const { data, error } = await sb.from("leads").select("id,name,loan_type,loan_amount,property_address,exit_strategy,close_date")
      .in("stage", ["closed", "postclosing"]).order("close_date", { ascending: false }).limit(limit);
    if (error) return { error: error.message };
    return { deals: (data || []).map((l) => ({
      id: l.id, name: l.name, loanType: l.loan_type, loanAmount: fmtUSD(l.loan_amount),
      propertyAddress: l.property_address, exitStrategy: l.exit_strategy, closeDate: l.close_date,
    })) };
  }
  if (name === "list_content_drafts") {
    const status = (input.status as string) || "all";
    let q = sb.from("site_content").select("id,type,title,status,wp_url,created_at").order("created_at", { ascending: false }).limit(20);
    if (status !== "all") q = q.eq("status", status);
    const { data, error } = await q;
    if (error) return { error: error.message };
    return { items: data || [] };
  }
  if (name === "create_content") {
    const contentId = "sc-" + crypto.randomUUID();
    const { error } = await sb.from("site_content").insert({
      id: contentId, type: input.type, lead_id: input.leadId || null,
      title: input.title, body: input.body, status: "draft", created_by: "owner-ai",
    });
    if (error) return { error: error.message };
    return { ok: true, contentId };
  }
  if (name === "publish_content") {
    const { data: row, error } = await sb.from("site_content").select("id").eq("id", input.contentId).single();
    if (error || !row) return { error: "content_not_found" };
    const { error: updErr } = await sb.from("site_content").update({
      status: "published", published_at: new Date().toISOString(),
    }).eq("id", row.id);
    if (updErr) return { ok: false, error: updErr.message };
    return { ok: true, url: "https://bridgepoint-crm-build.vercel.app/?showcase=1" };
  }
  if (name === "create_loan_file") {
    if (!LOAN_TYPES.includes(input.loanType as string)) return { error: "invalid_loan_type", validValues: LOAN_TYPES };
    if (!caller.isOwner && input.assignedTo && input.assignedTo !== caller.id) {
      return { error: "not_authorized", detail: "You can only create loan files assigned to yourself." };
    }
    const assignedTo = caller.isOwner ? (input.assignedTo as string | undefined) : caller.id;
    if (assignedTo) {
      const { data: staffCheck } = await sb.from("users").select("id").eq("id", assignedTo).single();
      if (!staffCheck) return { error: "invalid_assignedTo", detail: "No staff member with that id" };
    }
    const id = "L" + Math.random().toString(36).slice(2, 8).toUpperCase();
    const today = new Date().toISOString().slice(0, 10);
    const row: Record<string, unknown> = {
      id, name: input.name, email: input.email || null, phone: input.phone || null,
      source: input.source || "Referral", loan_type: input.loanType, stage: "new", status: "active",
      assigned_to: assignedTo || null, created_at: today,
      entity_type: "LLC", credit_score: input.creditScore || null,
      property_address: input.propertyAddress || null, property_type: input.propertyType || null,
      purchase_price: input.purchasePrice || null, loan_amount: input.loanAmount || null,
      rate: input.rate || null, term_months: input.termMonths || null, points_charged: input.pointsCharged || null,
      exit_strategy: input.exitStrategy || null, entity_legal_name: input.entityLegalName || null,
      outside_lender: input.outsideLender || null,
      application_token: crypto.randomUUID(),
      activity: [{ date: today, type: "note", text: "Loan file created by AI from a term sheet", author: "AI Assistant" }],
    };
    const { error } = await sb.from("leads").insert(row);
    if (error) return { error: error.message };
    const link = "https://bridgepoint-crm-build.vercel.app/?lead=" + id;
    if (input.notifyAssignee !== false && assignedTo) {
      const { data: assignee } = await sb.from("users").select("email,phone,name,quo_phone_number").eq("id", assignedTo).single();
      if (assignee?.email) {
        fetch(SUPABASE_URL + "/functions/v1/send-email", {
          method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
          body: JSON.stringify({ to: assignee.email, subject: "New loan file: " + input.name, text: "New loan file: " + input.name + " (" + input.loanType + ") — open & dial: " + link, fromName: "Bridgepoint CRM" }),
        }).catch(() => {});
      }
      if (assignee?.phone) {
        fetch(SUPABASE_URL + "/functions/v1/send-text", {
          method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
          body: JSON.stringify({ to: assignee.phone, text: "🔥 New loan file: " + input.name + " (" + input.loanType + ") — open & dial: " + link, fromName: "Bridgepoint CRM" }),
        }).catch(() => {});
      }
    }
    return { ok: true, leadId: id, link };
  }
  if (name === "update_loan_file") {
    const leadId = input.leadId as string;
    if (!leadId) return { error: "missing_leadId" };
    const { data: existing, error: fetchErr } = await sb.from("leads").select("*").eq("id", leadId).single();
    if (fetchErr || !existing) return { error: "lead_not_found" };
    if (!caller.isOwner && existing.assigned_to !== caller.id) {
      return { error: "not_authorized", detail: "That loan file isn't assigned to you." };
    }

    const fieldMap: Record<string, string> = {
      propertyAddress: "property_address", propertyType: "property_type", transactionType: "transaction_type",
      purchasePrice: "purchase_price", currentValue: "current_value", arv: "arv", rehabBudget: "rehab_budget",
      rentEstimate: "rent_estimate", monthlyTaxes: "monthly_taxes", monthlyInsurance: "monthly_insurance",
      monthlyHoa: "monthly_hoa", loanAmount: "loan_amount", rate: "rate", termMonths: "term_months",
      pointsCharged: "points_charged", creditScore: "credit_score", prepayTerm: "prepay_term",
      citizenshipStatus: "citizenship_status", exitStrategy: "exit_strategy",
    };
    const patch: Record<string, unknown> = {};
    const changedLabels: string[] = [];
    for (const [key, col] of Object.entries(fieldMap)) {
      const v = input[key];
      if (v !== undefined && v !== null && v !== "") {
        patch[col] = v;
        changedLabels.push(key + " = " + v);
      }
    }
    const loanProduct = input.loanProduct as string | undefined;
    if (loanProduct) {
      const dscrApp = (existing.dscr_app && typeof existing.dscr_app === "object") ? { ...existing.dscr_app as Record<string, unknown> } : {};
      dscrApp.loanProduct = loanProduct;
      patch.dscr_app = dscrApp;
      changedLabels.push("loanProduct = " + loanProduct);
    }
    if (Object.keys(patch).length === 0) return { error: "no_fields_provided" };

    const merged = { ...existing, ...patch } as Record<string, unknown>;
    const txnType = merged.transaction_type as string | null;
    const valueBasis = (txnType && txnType !== "purchase" && merged.current_value)
      ? (merged.current_value as number) : (merged.purchase_price as number | null);
    if (valueBasis && merged.loan_amount) {
      patch.ltv = Math.round(((merged.loan_amount as number) / valueBasis) * 1000) / 10;
    }

    const today = new Date().toISOString().slice(0, 10);
    const activity = Array.isArray(existing.activity) ? existing.activity as unknown[] : [];
    activity.push({
      date: today, type: "note",
      text: (input.changeSummary as string) || ("Loan scenario updated by AI: " + changedLabels.join(", ")),
      author: "AI Assistant",
    });
    patch.activity = activity;

    const { error: updErr } = await sb.from("leads").update(patch).eq("id", leadId);
    if (updErr) return { error: updErr.message };

    const link = "https://bridgepoint-crm-build.vercel.app/?lead=" + leadId;
    if (input.notifyAssignee !== false && existing.assigned_to) {
      const { data: assignee } = await sb.from("users").select("email,phone,name").eq("id", existing.assigned_to as string).single();
      const alertText = (existing.name as string) + "'s loan terms were updated: " + changedLabels.join(", ") + " — " + link;
      if (assignee?.email) {
        fetch(SUPABASE_URL + "/functions/v1/send-email", {
          method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
          body: JSON.stringify({ to: assignee.email, subject: "Loan terms updated: " + existing.name, text: alertText, fromName: "Bridgepoint CRM" }),
        }).catch(() => {});
      }
      if (assignee?.phone) {
        fetch(SUPABASE_URL + "/functions/v1/send-text", {
          method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
          body: JSON.stringify({ to: assignee.phone, text: alertText, fromName: "Bridgepoint CRM" }),
        }).catch(() => {});
      }
    }
    return { ok: true, leadId, link, changedFields: changedLabels };
  }
  if (name === "search_leads") {
    const query = ((input.query as string) || "").trim();
    if (!query) return { error: "missing_query" };
    let q = sb.from("leads")
      .select("id,name,phone,email,loan_type,stage,assigned_to")
      .or(`name.ilike.%${query}%,phone.ilike.%${query}%,email.ilike.%${query}%`);
    if (!caller.isOwner) q = q.eq("assigned_to", caller.id);
    const { data, error } = await q.limit(10);
    if (error) return { error: error.message };
    return { matches: data || [] };
  }
  if (name === "get_lead_details") {
    const { data, error } = await sb.from("leads").select("*").eq("id", input.leadId as string).single();
    if (error || !data) return { error: "lead_not_found" };
    if (!caller.isOwner && data.assigned_to !== caller.id) {
      return { error: "not_authorized", detail: "That loan file isn't assigned to you." };
    }
    return { lead: data };
  }
  if (name === "reassign_lead") {
    const { data: staffCheck } = await sb.from("users").select("id,name").eq("id", input.assignedTo as string).single();
    if (!staffCheck) return { error: "invalid_assignedTo" };
    const { data: existing } = await sb.from("leads").select("id,name,activity,assigned_to").eq("id", input.leadId as string).single();
    if (!existing) return { error: "lead_not_found" };
    if (!caller.isOwner && existing.assigned_to !== caller.id) {
      return { error: "not_authorized", detail: "That loan file isn't assigned to you." };
    }
    const today = new Date().toISOString().slice(0, 10);
    const activity = Array.isArray(existing.activity) ? existing.activity as unknown[] : [];
    activity.push({ date: today, type: "system", text: "Reassigned to " + staffCheck.name + " by AI Assistant", author: "AI Assistant" });
    const { error } = await sb.from("leads").update({ assigned_to: input.assignedTo, activity }).eq("id", input.leadId as string);
    if (error) return { error: error.message };
    return { ok: true, leadId: input.leadId, assignedTo: staffCheck.name };
  }
  if (name === "add_lead_note") {
    const { data: existing } = await sb.from("leads").select("id,activity,assigned_to").eq("id", input.leadId as string).single();
    if (!existing) return { error: "lead_not_found" };
    if (!caller.isOwner && existing.assigned_to !== caller.id) {
      return { error: "not_authorized", detail: "That loan file isn't assigned to you." };
    }
    const today = new Date().toISOString().slice(0, 10);
    const activity = Array.isArray(existing.activity) ? existing.activity as unknown[] : [];
    activity.push({ date: today, type: "note", text: input.note as string, author: "AI Assistant" });
    const { error } = await sb.from("leads").update({ activity }).eq("id", input.leadId as string);
    if (error) return { error: error.message };
    return { ok: true, leadId: input.leadId };
  }
  if (name === "email_team" || name === "text_team") {
    let query = sb.from("users").select("id,name,email,phone,quo_phone_number,role").neq("id", "demo").neq("id", "demo-processor");
    const recipients = input.recipients as string;
    if (recipients === "loan_officers") query = query.eq("role", "loan_officer");
    else if (recipients === "processors") query = query.eq("role", "processor");
    else if (recipients === "specific") {
      const ids = (input.staffIds as string[]) || [];
      if (!ids.length) return { error: "missing_staffIds" };
      query = query.in("id", ids);
    } else if (recipients !== "all_staff") return { error: "invalid_recipients" };
    const { data: staffList, error } = await query;
    if (error) return { error: error.message };
    if (!staffList || !staffList.length) return { error: "no_matching_staff" };
    return {
      ok: true,
      requiresFrontendAction: name,
      staff: staffList.map((s) => ({ id: s.id, name: s.name })),
      subject: input.subject || null,
      body: name === "email_team" ? input.body : input.text,
    };
  }
  if (name === "send_document") {
    const { data: lead } = await sb.from("leads").select("id,assigned_to").eq("id", input.leadId).single();
    if (!lead) return { error: "lead_not_found" };
    if (!caller.isOwner && lead.assigned_to !== caller.id) {
      return { error: "not_authorized", detail: "That loan file isn't assigned to you." };
    }
    if (input.kind !== "preapproval" && input.kind !== "termSheet") return { error: "invalid_kind" };
    // Actual bilingual send happens client-side (reuses the CRM's tested
    // send pipeline) -- this just validates and signals the frontend to do it.
    return { ok: true, requiresFrontendAction: "send_document", leadId: input.leadId, kind: input.kind };
  }
  if (name === "start_retargeting_campaign") {
    const channel = input.channel as string;
    if (!["email", "text", "both"].includes(channel)) return { error: "invalid_channel" };
    let assignedTo = input.assignedTo as string | undefined;
    let leadIds = input.leadIds as string[] | undefined;
    const noContactDays = typeof input.noContactDays === "number" ? input.noContactDays : undefined;
    if (!caller.isOwner) {
      if (assignedTo && assignedTo !== caller.id) {
        return { error: "not_authorized", detail: "You can only run a campaign against your own leads." };
      }
      if (leadIds && leadIds.length) {
        const { data: ownedCheck } = await sb.from("leads").select("id,assigned_to").in("id", leadIds);
        const notOwned = (ownedCheck || []).filter((l) => l.assigned_to !== caller.id);
        if (notOwned.length) return { error: "not_authorized", detail: "Some of those loan files aren't assigned to you." };
      } else {
        assignedTo = caller.id;
        leadIds = undefined;
      }
    }
    if (!assignedTo && (!leadIds || !leadIds.length) && !noContactDays) return { error: "missing_target", detail: "Provide assignedTo, leadIds, or noContactDays" };

    let q = sb.from("leads").select("id,name,email,phone,loan_type,assigned_to,activity,call_attempts,first_attempt_at,created_at,created_at_ts").eq("status", "active");
    if (leadIds && leadIds.length) q = q.in("id", leadIds);
    else if (assignedTo) q = q.eq("assigned_to", assignedTo);
    const { data: leadsFetched, error } = await q.limit(500);
    if (error) return { error: error.message };
    let leadsRaw = leadsFetched || [];

    // "No contact in N days" isn't a single column -- derive last real human
    // contact from call attempts, first-contact timestamp, and any logged
    // call/text/email activity, falling back to lead creation if truly never
    // touched. Skip (never guess stale) any lead with no determinable date.
    if (noContactDays) {
      const thresholdMs = noContactDays * 24 * 3600 * 1000;
      const now = Date.now();
      leadsRaw = leadsRaw.filter((l) => {
        const dates: number[] = [];
        (Array.isArray(l.activity) ? l.activity as Array<Record<string, unknown>> : []).forEach((a) => {
          if (a && ["call", "text", "email"].includes(a.type as string) && typeof a.date === "string") {
            const t = new Date(a.date + "T12:00:00Z").getTime();
            if (!isNaN(t)) dates.push(t);
          }
        });
        (Array.isArray(l.call_attempts) ? l.call_attempts as Array<Record<string, unknown>> : []).forEach((c) => {
          if (c && typeof c.date === "string") {
            const t = new Date(c.date + "T12:00:00Z").getTime();
            if (!isNaN(t)) dates.push(t);
          }
        });
        if (l.first_attempt_at) {
          const t = new Date(l.first_attempt_at as string).getTime();
          if (!isNaN(t)) dates.push(t);
        }
        let baseline = dates.length ? Math.max(...dates) : null;
        if (baseline == null) {
          if (l.created_at_ts) baseline = new Date(l.created_at_ts as string).getTime();
          else if (l.created_at) baseline = new Date(l.created_at as string + "T12:00:00Z").getTime();
        }
        if (baseline == null || isNaN(baseline)) return false;
        return (now - baseline) >= thresholdMs;
      });
    }
    if (!leadsRaw.length) return { error: "no_matching_leads" };

    // Real TCPA opt-outs (a genuine "replied STOP" record in activity) are
    // never texted again -- but TCPA/STOP governs calls and texts, not
    // email (that's CAN-SPAM, a separate opt-out mechanism), so a text
    // opt-out should never block email or getting called. Distinct from
    // automation_paused, which is also set on leads simply imported without
    // enrolling them in the autonomous AI texting bot -- not an opt-out.
    const textOptedOut = new Set(
      leadsRaw.filter((l) => (Array.isArray(l.activity) ? l.activity : []).some((a: Record<string, unknown>) =>
        typeof a.text === "string" && a.text.toLowerCase().includes("tcpa opt-out")
      )).map((l) => l.id)
    );
    let leads = leadsRaw;
    let skippedForOptOut = 0;
    if (channel === "text") {
      leads = leadsRaw.filter((l) => !textOptedOut.has(l.id));
      skippedForOptOut = textOptedOut.size;
      if (!leads.length) return { error: "no_matching_leads", detail: "All matching leads have opted out of texts (TCPA)." };
    }

    const loIds = [...new Set(leads.map((l) => l.assigned_to).filter(Boolean))] as string[];
    const { data: staffRows } = loIds.length
      ? await sb.from("users").select("id,name,phone,quo_phone_number").in("id", loIds)
      : { data: [] as Record<string, unknown>[] };
    const staffMap: Record<string, { name?: string; phone?: string; quo_phone_number?: string }> = {};
    (staffRows || []).forEach((s) => { staffMap[s.id as string] = s as { name?: string; phone?: string; quo_phone_number?: string }; });

    const recipients = leads
      .map((l) => {
        const lo = staffMap[l.assigned_to as string] || {};
        // channel "both" + a text opt-out: keep the email, drop only the phone
        // so this person still gets emailed but is never texted again.
        const phoneAllowed = channel !== "both" || !textOptedOut.has(l.id);
        if (channel === "both" && textOptedOut.has(l.id)) skippedForOptOut++;
        return {
          leadId: l.id, name: l.name, firstName: (l.name || "there").split(" ")[0],
          email: l.email || null, phone: phoneAllowed ? (l.phone || null) : null, loanType: l.loan_type || null,
          loId: l.assigned_to || null, loName: lo.name || "your Bridgepoint contact",
          loPhone: lo.quo_phone_number || lo.phone || "",
          bookingLink: "https://bridgepoint-crm-build.vercel.app/?book=" + (l.assigned_to || "owner"),
        };
      })
      .filter((r) => {
        if (channel === "email") return !!r.email;
        if (channel === "text") return !!r.phone;
        return !!r.email || !!r.phone;
      });
    if (!recipients.length) return { error: "no_contactable_recipients" };

    // Guaranteed A2P/TCPA-compliant opt-out language on every text, appended
    // server-side rather than trusted to the drafted copy.
    let textBodyTemplate = (input.textBodyTemplate as string) || "";
    if (!/reply stop/i.test(textBodyTemplate)) textBodyTemplate = textBodyTemplate.trim() + " Reply STOP to opt out.";

    return {
      ok: true, requiresFrontendAction: "review_campaign", channel,
      emailSubject: input.emailSubject, emailBodyTemplate: input.emailBodyTemplate, textBodyTemplate,
      recipients, count: recipients.length, skippedForOptOut,
      skippedForOptOutMeaning: channel === "both" ? "kept for email, text suppressed only" : "excluded entirely",
      matchedByNoContactDays: noContactDays || null,
    };
  }
  if (name === "analyze_engagement_performance") {
    const { data: config } = await sb.from("engagement_config").select("*").eq("id", "default").single();
    const { data: leads } = await sb.from("leads")
      .select("id,name,loan_type,source,assigned_to,stage,status,ai_stage,automation_paused,created_at_ts,first_attempt_at,call_attempts,activity")
      .limit(500);
    const rows = leads || [];

    const engaged = rows.filter((l) => l.ai_stage || (Array.isArray(l.call_attempts) && l.call_attempts.length));
    const converted = rows.filter((l) => ["app_sent", "app_completed", "docs", "processing", "underwriting", "approved", "ctc", "closed", "postclosing"].includes(l.stage as string));
    const optedOut = rows.filter((l) => (Array.isArray(l.activity) ? l.activity : []).some((a: Record<string, unknown>) => typeof a.text === "string" && a.text.toLowerCase().includes("tcpa opt-out")));
    const cold = rows.filter((l) => l.status === "cold" || l.status === "lost");
    const repliedToAiText = rows.filter((l) => l.ai_stage && (Array.isArray(l.activity) ? l.activity : []).some((a: Record<string, unknown>) => typeof a.text === "string" && a.text.startsWith("Received (via Quo)")));

    const byLoanType: Record<string, { total: number; converted: number }> = {};
    rows.forEach((l) => {
      const key = (l.loan_type as string) || "unknown";
      byLoanType[key] = byLoanType[key] || { total: 0, converted: 0 };
      byLoanType[key].total++;
      if (converted.includes(l)) byLoanType[key].converted++;
    });

    const { data: recentCoaching } = await sb.from("coaching_notes").select("source,note,created_at").order("created_at", { ascending: false }).limit(15);

    return {
      currentConfig: { cadenceMax: config?.cadence_max, messagingGuidance: config?.messaging_guidance || "(none set)" },
      totalLeads: rows.length,
      engagedCount: engaged.length,
      aiTextedCount: rows.filter((l) => l.ai_stage).length,
      repliedToAiTextCount: repliedToAiText.length,
      convertedToApplicationOrBeyond: converted.length,
      wentColdOrLost: cold.length,
      textOptOuts: optedOut.length,
      conversionByLoanType: byLoanType,
      recentCoachingNotes: (recentCoaching || []).map((c) => ({ source: c.source, note: c.note, date: c.created_at })),
      caveat: "Sample sizes here may be very small if the system is new -- weight recommendations accordingly, and say so plainly rather than overclaiming a pattern.",
    };
  }
  if (name === "analyze_lo_speed_to_lead") {
    const missedThresholdHours = typeof input.missedThresholdHours === "number" ? input.missedThresholdHours : 48;
    let query = sb.from("leads")
      .select("id,name,assigned_to,stage,status,loan_amount,points_charged,created_at_ts,created_at,first_attempt_at,activity")
      .limit(1000);
    if (!caller.isOwner) query = query.eq("assigned_to", caller.id);
    else if (input.assignedTo) query = query.eq("assigned_to", input.assignedTo as string);
    const { data: leads } = await query;
    const rows = leads || [];

    const { data: staff } = await sb.from("users").select("id,name,role").eq("role", "loan_officer");
    const nameById: Record<string, string> = {};
    (staff || []).forEach((u) => { nameById[u.id as string] = u.name as string; });

    const CONVERTED_STAGES = ["app_sent", "app_completed", "docs", "processing", "underwriting", "approved", "ctc", "closed", "postclosing"];
    const now = Date.now();

    // Real deal economics from whatever's actually on file, used only to
    // turn "N missed leads" into a rough dollar estimate -- never a made-up
    // constant. Origination revenue only (points x loan amount), not lender
    // or processing fees, so this is a floor, not a full P&L number.
    const withEconomics = rows.filter((l) => l.loan_amount && l.points_charged);
    const avgLoanAmount = withEconomics.length ? withEconomics.reduce((s, l) => s + (l.loan_amount as number), 0) / withEconomics.length : null;
    const avgPointsPct = withEconomics.length ? withEconomics.reduce((s, l) => s + (l.points_charged as number), 0) / withEconomics.length : null;
    const revenuePerFundedDeal = avgLoanAmount && avgPointsPct ? avgLoanAmount * (avgPointsPct / 100) : null;
    const outcomeKnown = rows.filter((l) => CONVERTED_STAGES.includes(l.stage as string) || l.status === "cold" || l.status === "lost");
    const converted = rows.filter((l) => CONVERTED_STAGES.includes(l.stage as string));
    const observedConversionRate = outcomeKnown.length ? converted.length / outcomeKnown.length : null;

    type PerLead = { id: string; name: string; hoursToFirstCall: number | null; hadAnyHumanContact: boolean; missed: boolean; ageHours: number };
    const byLo: Record<string, { name: string; leads: PerLead[] }> = {};

    rows.forEach((l) => {
      const assignedTo = (l.assigned_to as string) || "unassigned";
      const createdAtMs = l.created_at_ts ? new Date(l.created_at_ts as string).getTime() : (l.created_at ? new Date(l.created_at as string + "T12:00:00Z").getTime() : null);
      if (!createdAtMs) return; // can't measure speed without a creation time
      const ageHours = (now - createdAtMs) / 3600000;

      let hoursToFirstCall: number | null = null;
      if (l.first_attempt_at) {
        const h = (new Date(l.first_attempt_at as string).getTime() - createdAtMs) / 3600000;
        if (h >= 0) hoursToFirstCall = Math.round(h * 10) / 10;
      }
      const activity = Array.isArray(l.activity) ? (l.activity as Array<Record<string, unknown>>) : [];
      const hadHumanTextOrEmail = activity.some((a) => (a.type === "text" || a.type === "email") && a.initiatedBy === "staff");
      const hadAnyHumanContact = hoursToFirstCall !== null || hadHumanTextOrEmail;
      const missed = !hadAnyHumanContact && ageHours >= missedThresholdHours;

      byLo[assignedTo] = byLo[assignedTo] || { name: nameById[assignedTo] || assignedTo, leads: [] };
      byLo[assignedTo].leads.push({ id: l.id as string, name: l.name as string, hoursToFirstCall, hadAnyHumanContact, missed, ageHours: Math.round(ageHours) });
    });

    const report = Object.entries(byLo).map(([id, v]) => {
      const withCallTiming = v.leads.filter((l) => l.hoursToFirstCall !== null);
      const sorted = withCallTiming.map((l) => l.hoursToFirstCall as number).sort((a, b) => a - b);
      const avgHoursToFirstCall = sorted.length ? Math.round((sorted.reduce((s, h) => s + h, 0) / sorted.length) * 10) / 10 : null;
      const medianHoursToFirstCall = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
      const missedLeads = v.leads.filter((l) => l.missed);
      return {
        loId: id,
        loName: v.name,
        totalLeads: v.leads.length,
        neverHumanContacted: v.leads.filter((l) => !l.hadAnyHumanContact).length,
        missedLeadsCount: missedLeads.length,
        missedLeads: missedLeads.map((l) => ({ id: l.id, name: l.name, hoursSinceCreated: Math.round(l.ageHours) })),
        avgHoursToFirstCall,
        medianHoursToFirstCall,
        estimatedIncomeLeftOnTable: revenuePerFundedDeal && observedConversionRate
          ? Math.round(missedLeads.length * observedConversionRate * revenuePerFundedDeal)
          : null,
      };
    }).sort((a, b) => b.missedLeadsCount - a.missedLeadsCount);

    return {
      missedThresholdHours,
      perLoanOfficer: report,
      economicsUsedForEstimate: revenuePerFundedDeal ? {
        avgLoanAmount: Math.round(avgLoanAmount as number),
        avgPointsPct: Math.round((avgPointsPct as number) * 100) / 100,
        revenuePerFundedDeal: Math.round(revenuePerFundedDeal),
        observedConversionRate: observedConversionRate ? Math.round(observedConversionRate * 1000) / 10 + "%" : null,
      } : null,
      caveat: "Call timing (hoursToFirstCall) is precise and fully reliable -- the AI never dials, so every call attempt is a real human action. Text/email speed is NOT included as a timing metric (activity is only date-precise, not time-of-day) -- it only feeds hadAnyHumanContact/missed as a yes/no signal, and only for messages sent after this tracking was added, so leads worked entirely before then may show as falsely missed if contacted only by text/email. Income-left-on-table is a rough floor estimate from average points revenue on file times the observed conversion rate -- not lender/processing fees, and unreliable with a small sample.",
    };
  }
  if (name === "apply_engagement_adjustment") {
    if (!input.reason) return { error: "missing_reason" };
    const patch: Record<string, unknown> = { last_adjustment_reason: input.reason, last_adjusted_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    if (input.cadenceMax != null) patch.cadence_max = input.cadenceMax;
    if (input.messagingGuidance != null) patch.messaging_guidance = input.messagingGuidance;
    const { error } = await sb.from("engagement_config").update(patch).eq("id", "default");
    if (error) return { error: error.message };
    return { ok: true, applied: patch };
  }
  if (name === "analyze_growth_progress") {
    const { data: goal } = await sb.from("growth_goals").select("*").eq("id", "default").single();
    const { data: leads } = await sb.from("leads").select("id,source,loan_amount,points_charged,rate,loan_type,stage,status,created_at,close_date,assigned_to");
    const rows = leads || [];
    const { data: loStaff } = await sb.from("users").select("id,name").eq("role", "loan_officer");

    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const thisMonth = rows.filter((l) => l.created_at && new Date(l.created_at as string) >= monthStart);
    const bySource: Record<string, number> = {};
    thisMonth.forEach((l) => { const s = (l.source as string) || "unknown"; bySource[s] = (bySource[s] || 0) + 1; });

    const closedThisMonth = rows.filter((l) => (l.stage === "closed" || l.stage === "postclosing") && l.close_date && new Date(l.close_date as string) >= monthStart);
    const fundedVolumeThisMonth = closedThisMonth.reduce((s, l) => s + ((l.loan_amount as number) || 0), 0);

    const active = rows.filter((l) => l.status === "active");
    const activePipelineVolume = active.reduce((s, l) => s + ((l.loan_amount as number) || 0), 0);
    const withAmount = rows.filter((l) => l.loan_amount);
    const avgLoanSize = withAmount.length ? withAmount.reduce((s, l) => s + (l.loan_amount as number), 0) / withAmount.length : null;

    const pointsRevenue = (l: Record<string, unknown>) => (l.points_charged && l.loan_amount) ? (l.loan_amount as number) * ((l.points_charged as number) / 100) : 0;
    const activePointsRevenue = active.reduce((s, l) => s + pointsRevenue(l), 0);
    const closedPointsRevenueThisMonth = closedThisMonth.reduce((s, l) => s + pointsRevenue(l), 0);

    const stageBreakdown: Record<string, number> = {};
    rows.forEach((l) => { const st = (l.stage as string) || "unknown"; stageBreakdown[st] = (stageBreakdown[st] || 0) + 1; });

    // Per-LO pace, for "how do I hit the goal with the employees I have"
    // style questions -- combine with analyze_lo_speed_to_lead for a full
    // capacity picture (this shows current pace/mix, that shows missed-lead
    // slack capacity).
    type LoStat = { loId: string; loName: string; closedCountThisMonth: number; closedVolumeThisMonth: number; activePipelineCount: number; activePipelineVolume: number };
    const byLo: Record<string, LoStat> = {};
    (loStaff || []).forEach((u) => { byLo[u.id as string] = { loId: u.id as string, loName: u.name as string, closedCountThisMonth: 0, closedVolumeThisMonth: 0, activePipelineCount: 0, activePipelineVolume: 0 }; });
    closedThisMonth.forEach((l) => {
      const id = l.assigned_to as string;
      if (id && byLo[id]) { byLo[id].closedCountThisMonth++; byLo[id].closedVolumeThisMonth += (l.loan_amount as number) || 0; }
    });
    active.forEach((l) => {
      const id = l.assigned_to as string;
      if (id && byLo[id]) { byLo[id].activePipelineCount++; byLo[id].activePipelineVolume += (l.loan_amount as number) || 0; }
    });

    const goalStart = goal?.goal_start_date ? new Date(goal.goal_start_date as string) : new Date();
    const monthsElapsed = Math.max(1, Math.round((Date.now() - goalStart.getTime()) / (30 * 24 * 3600 * 1000)));

    return {
      goal: {
        currentTargetMonthly: goal?.current_target_monthly, consecutiveMonthsRequired: goal?.consecutive_months_required,
        consecutiveMonthsHit: goal?.consecutive_months_hit, nextTargetMonthly: goal?.next_target_monthly,
        deadlineMonths: goal?.target_deadline_months, monthsElapsedSinceGoalStart: monthsElapsed,
        knownBaseline: { cixLeadsPerMonth: goal?.cix_leads_per_month, dailyFbSpend: goal?.daily_fb_spend, monthlyFbSpend: (goal?.daily_fb_spend || 0) * 30 },
      },
      fundedVolumeThisMonth, fundedLoansThisMonth: closedThisMonth.length,
      totalLeadsAllTime: rows.length, leadsThisMonth: thisMonth.length, leadsThisMonthBySource: bySource,
      activePipelineCount: active.length, activePipelineVolume, avgLoanSize,
      revenue: { activePipelinePointsRevenue: Math.round(activePointsRevenue), closedPointsRevenueThisMonth: Math.round(closedPointsRevenueThisMonth), note: "Points-based revenue only (loan_amount x points_charged%) -- YSP is NOT included here. For any question involving YSP/yield-spread/total commission, use the REAL-TIME REVENUE SNAPSHOT in the system prompt instead, which is computed live by the app's own pricer." },
      pipelineByStage: stageBreakdown,
      perLoanOfficer: Object.values(byLo).sort((a, b) => b.closedCountThisMonth - a.closedCountThisMonth),
      caveat: "If fundedVolumeThisMonth is 0 or leadsThisMonth is small, the system is early and this is a thin/unreliable sample for pacing math -- say so plainly rather than projecting confidently from noise.",
    };
  }
  if (name === "update_growth_goal") {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const map: Record<string, string> = {
      currentTargetMonthly: "current_target_monthly", consecutiveMonthsRequired: "consecutive_months_required",
      consecutiveMonthsHit: "consecutive_months_hit", nextTargetMonthly: "next_target_monthly",
      targetDeadlineMonths: "target_deadline_months", cixLeadsPerMonth: "cix_leads_per_month",
      dailyFbSpend: "daily_fb_spend", notes: "notes",
    };
    for (const [key, col] of Object.entries(map)) { if (input[key] !== undefined) patch[col] = input[key]; }
    if (Object.keys(patch).length === 1) return { error: "no_fields_provided" };
    const { error } = await sb.from("growth_goals").update(patch).eq("id", "default");
    if (error) return { error: error.message };
    return { ok: true, applied: patch };
  }
  if (name === "analyze_pricing_competitiveness") {
    const { data: rates } = await sb.from("market_rates").select("key,label,current,previous");
    const { data: leads } = await sb.from("leads").select("loan_type,rate,points_charged,loan_amount,stage,status").not("rate", "is", null);
    const rows = leads || [];
    const byType: Record<string, { count: number; avgRate: number; avgPoints: number; parRate: number | null }> = {};
    (rates || []).forEach((r) => {
      const typeLeads = rows.filter((l) => (l.loan_type as string) === r.label || (l.loan_type as string)?.toLowerCase() === (r.key as string)?.toLowerCase());
      if (!typeLeads.length) return;
      byType[r.label as string] = {
        count: typeLeads.length,
        avgRate: Math.round((typeLeads.reduce((s, l) => s + ((l.rate as number) || 0), 0) / typeLeads.length) * 1000) / 1000,
        avgPoints: Math.round((typeLeads.reduce((s, l) => s + ((l.points_charged as number) || 0), 0) / typeLeads.length) * 100) / 100,
        parRate: r.current as number,
      };
    });
    return {
      byLoanType: byType,
      allParRates: (rates || []).map((r) => ({ type: r.label, par: r.current, previous: r.previous })),
      caveat: "There is NO external competitor/industry rate-comparison feed in this system -- this only shows Bridgepoint's own actual charged rate/points vs its own wholesale par rate (i.e. real margin), never claim to know what a competitor or 'the industry' is actually charging right now.",
    };
  }
  return { error: "unknown_tool" };
}

// Resolves who is REALLY calling, from the real Supabase Auth JWT the
// frontend's own sb client attaches to every functions.invoke() once a
// staff member has logged in via staff-login -- never from the
// client-supplied body.userId, which is only a convenience label anyone
// could set to anything. Demo accounts have no auth_id by design (see
// staff-login) and carry no real JWT, so they're let through as owner --
// same as the rest of the app's isOwner(), and harmless since demo has no
// real leads/data. Anyone else with no resolvable JWT is refused outright.
async function resolveCaller(req: Request, bodyUserId: string | undefined): Promise<Caller | null> {
  if (bodyUserId === "demo" || bodyUserId === "demo-processor") {
    return { id: bodyUserId, name: "Demo", role: "owner", isOwner: true };
  }
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token || token === ANON_KEY) return null;
  const sbAsCaller = createClient(SUPABASE_URL, ANON_KEY);
  const { data: authData, error: authErr } = await sbAsCaller.auth.getUser(token);
  if (authErr || !authData?.user) return null;
  const { data: userRow, error: userErr } = await sb.from("users").select("id,name,role,full_access").eq("auth_id", authData.user.id).single();
  if (userErr || !userRow) return null;
  return { id: userRow.id, name: userRow.name, role: userRow.role, isOwner: userRow.role === "owner" || userRow.full_access === true };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const message: string = body.message;
    // Optional term sheet attachment (PDF or image), base64-encoded.
    const attachmentBase64: string | null = body.attachmentBase64 || null;
    const attachmentMediaType: string | null = body.attachmentMediaType || null;
    const businessSnapshot: Record<string, unknown> | null = body.businessSnapshot || null;
    if (!message && !attachmentBase64) {
      return new Response(JSON.stringify({ error: "missing_message" }), { status: 400, headers: CORS_HEADERS });
    }

    const caller = await resolveCaller(req, body.userId);
    if (!caller) {
      return new Response(JSON.stringify({ error: "unauthenticated", detail: "Please log in again." }), { status: 401, headers: CORS_HEADERS });
    }
    const userId = caller.id;

    const { data: history } = await sb.from("ai_chat_messages").select("role,content").eq("user_id", userId)
      .order("created_at", { ascending: false }).limit(20);
    const priorMessages = (history || []).reverse().map((m) => ({ role: m.role, content: m.content }));

    const userContent: Array<Record<string, unknown>> = [];
    if (attachmentBase64 && attachmentMediaType) {
      const blockType = attachmentMediaType === "application/pdf" ? "document" : "image";
      userContent.push({ type: blockType, source: { type: "base64", media_type: attachmentMediaType, data: attachmentBase64 } });
    }
    userContent.push({ type: "text", text: message || "Here's a term sheet -- create a loan file from it." });

    const messages: Array<Record<string, unknown>> = [...priorMessages, { role: "user", content: userContent }];
    const actionsTaken: Array<Record<string, unknown>> = [];
    const systemPrompt = await buildSystemPrompt(caller, businessSnapshot);

    let finalText = "";
    for (let iter = 0; iter < 6; iter++) {
      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 4096, system: systemPrompt, messages, tools: TOOLS }),
      });
      const aiData = await aiRes.json();
      if (!aiRes.ok) {
        return new Response(JSON.stringify({ error: "anthropic_error", detail: aiData }), { status: 502, headers: CORS_HEADERS });
      }

      const content = aiData.content || [];
      const textParts = content.filter((c: Record<string, unknown>) => c.type === "text").map((c: Record<string, unknown>) => c.text).join("\n");
      const toolUses = content.filter((c: Record<string, unknown>) => c.type === "tool_use");

      if (toolUses.length === 0) {
        finalText = textParts;
        if (aiData.stop_reason === "max_tokens" && !finalText) {
          finalText = "Ran out of room thinking about that one -- try again, maybe with a shorter/simpler request.";
        }
        break;
      }

      messages.push({ role: "assistant", content });
      const toolResults = [];
      for (const tu of toolUses) {
        const result = await runTool(tu.name, tu.input || {}, caller);
        actionsTaken.push({ tool: tu.name, input: tu.input, result });
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      messages.push({ role: "user", content: toolResults });
    }

    const historyText = (message || "") + (attachmentBase64 ? " [attached a document/image]" : "");
    await sb.from("ai_chat_messages").insert([
      { id: "msg-" + crypto.randomUUID(), user_id: userId, role: "user", content: historyText },
      { id: "msg-" + crypto.randomUUID(), user_id: userId, role: "assistant", content: finalText || "(no reply)" },
    ]);

    return new Response(JSON.stringify({ ok: true, reply: finalText, actions: actionsTaken }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
