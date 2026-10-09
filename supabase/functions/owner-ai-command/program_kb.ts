// Loan-program knowledge for the AI assistant (Joe 2026-10-09: "in the LOs' AI assistant make sure
// they can ask anything about loan products/rules/guidelines and get an answer").
// EXTERNAL_KB = the Bridgepoint-branded program matrix (no lender names) -- every staff member.
// INTERNAL_KB = the lender map -- ONLY Joe, Fiore and Erika (Joe 10/8: "internal only goes to me,
// fiore and erika"; LOs never see lender names).
// Source: the "Bridgepoint Lending — Loan Program Matrix" and "Bridgepoint Program Matrix — Internal"
// docs (10/8/26), plus rules added since (RCN and LEND do no mixed-use, 10/8). Update this file when
// the matrices or the pricer's rules change.

export const EXTERNAL_KB = `
BRIDGEPOINT LENDING — LOAN PROGRAMS (as of Oct 9, 2026)
Business-purpose investment property only (non-owner-occupied). Closes in an LLC or corporation unless noted. Rates move daily and are quoted per scenario — the Pricer gives the exact quote; this is maximums and minimums.

AT A GLANCE
| Program | Max leverage | Min credit | Loan size | Term |
| Fix & Flip / Rehab | up to 95% of total cost (90% of purchase), 100% of rehab, max 75% of ARV | 650 | $75k–$3M | 9–24 mo interest-only |
| Bridge (no rehab) | up to 75% of as-is value | 680 | $100k–$3M | 12–24 mo interest-only |
| Ground-Up Construction | up to 95% of total cost, max 75% of completed value | 660 | $100k–$2M | 12–24 mo interest-only |
| DSCR Rental (1–4 units) | 80% purchase, 80% rate/term, 75% cash-out | 620 | $75k–$3M | 30-yr fixed, 40-yr, 5/1 & 7/1 ARM, interest-only |
| Short-Term Rental | up to 80% purchase | 620 | $75k–$2M | 30-yr fixed |
| 5+ Unit Multifamily | up to 75% | 700 | from $250k | 30-yr fixed |
| Mixed-Use (rental only) | up to 75% | 680 | from $75k | 30-yr fixed, interest-only |
| Commercial (rental only) | up to 70% | per scenario | per scenario | 30-yr fixed, interest-only |
| Portfolio / Blanket | 80% purchase, 75% cash-out | 680 | 2+ properties | 30-yr fixed |

FIX & FLIP / REHAB — by completed projects in the last 36 months: 0 (first-time): 90% LTC, 75% ARV, 680 min; 1–2: 90%/75%, 660; 3–6: 92.5%/75%, 660; 7+: 95%/75%, 700. The max in each row needs 700+; at the row's minimum credit, expect less (run the Pricer for the exact number). Never quote the row max for a borrower under 700.
- Rehab funded up to 100% through draws; heavy/structural rehab (gut, additions, conversions) needs 2+ completed projects.
- Property types: SFR, townhome, condo, 2–4 units; 5+ units from $250k. Mixed-use buildings are financed as RENTALS only — no flip, bridge or ground-up on mixed-use.
- Refinance: rate/term at purchase terms; cash-out needs 700+, up to 78% of cost; owned 10+ months can be sized on today's value.
- Borrower brings at least the gap between purchase price and the initial advance, plus closing costs.

BRIDGE (no rehab): 720+ credit up to 75% of as-is; 680–719 up to 70%; cash-out refinance 55–70%. Leverage on the lower of price and as-is value; refinance owned under 10 months sized on what was paid. SFR, townhome, condo, 2–4 units.

GROUND-UP CONSTRUCTION — by completed BUILDS (ground-up only, flips don't count) in 36 months: 1 build: 85% LTC, 65% of completed value, 700 min; 2–3: 90%/70%, 660; 4–6: 93%/72.5%, 660; 7+: 95%/75%, 660. The max in each row needs 700+ (under 700 expect less; run the Pricer); it drops 5–7 points when land is 15%+ of completed value. Land advance at closing 65–75% of land value (some programs 50% until stamped plans/permits). SFR, townhome, 2–4 units; no condos, 5+ or mid-construction projects; no cash-out. First-time builders: limited options (US citizens, 650+, higher rate) — run the Pricer.

DSCR RENTALS (1–4 units) — qualified on the property's rent, no personal income or tax returns.
| Credit | Purchase / rate-term | Cash-out | Max loan at that leverage |
| 720+ | 80% | 75% | $1.5M (65% up to $3M) |
| 700–719 | 80% | 75% | $1.5M (65% up to $2.5M) |
| 680–699 | 75% | 70% | $1M (70% up to $2M) |
| 640–679 | 70% | 65% | $1M |
| 620–639 | 65% | 65% | $1M |
- DSCR (rent ÷ payment incl. taxes, insurance, HOA): 1.00+ for full leverage; 0.75–0.99 up to 75%; under 0.75 (no-ratio) up to 70%.
- SFR, townhome/PUD, condo (incl. non-warrantable, condotel), 2–4 units. Products: 30-yr fixed, 40-yr fixed, 5/1 & 7/1 ARM, interest-only.
- Prepay: none or 1–5 years (longer prepay = lower rate; some states don't allow prepay). Rate/term prices like a purchase; any cash to borrower = cash-out.

SHORT-TERM RENTALS (Airbnb/VRBO): 700+: 80% purchase / 75% cash-out; 680–699: 75/70; 640–679: 70/65; 620–639: 65/65. Pricing a bit higher above 70% LTV. Rent from 12-month booking history or a market projection; some programs count 80% of STR income or cap at 75%. DSCR 1.00+ (1.15+ on some). SFR/townhome everywhere; condos and 2–4 units on select programs. Docs: active listing, platform income statements, 2 months of deposits.

5+ MULTIFAMILY, MIXED-USE, COMMERCIAL (rental/hold loans):
- 5+ unit apartments: 75% purchase, 70% cash-out, 700 min, from $250k; 1.25 DSCR on 5–9 unit buildings.
- Mixed-use (residential + commercial units): 75%, 680, from $75k — rental loans only.
- Office, retail, warehouse, self-storage, automotive, mobile home parks, commercial condos, day care: up to 70%, priced individually; no rehab financing.
- 30-yr fixed with interest-only up to 10 years; low-leverage streamlined options. Foreign investors with no US credit: up to 65%.

PORTFOLIO / BLANKET: one loan on 2+ rentals; up to 80% of combined value (purchase), 75% cash-out. Each property SFR, townhome, condo or 2–4 units; can be in different states. Sized on combined value, rent, taxes, insurance, HOA. 680+; DSCR 1.00–1.20+ by credit. Rate/term up to combined payoff + costs. 30-yr fixed, 5/7/10 ARMs, IO; prepay none–5 yrs. Use Portfolio/Blanket in the Pricer.

BORROWER ELIGIBILITY:
| Borrower | Fix & Flip / Bridge | Ground-Up | Rentals (DSCR) |
| US citizen / permanent resident | Yes | Yes | Yes |
| Visa holder (non-permanent resident) | Select programs | Case by case | Yes, 700+ |
| Foreign national (lives abroad) | Yes via US entity, ~5% less leverage | No | Up to 75% with US credit, 65% without |
| ITIN | No | No | Yes, 700+, up to 70%, no cash-out |
- Entity: flips, bridge, ground-up close in an LLC/corp; rentals prefer an entity (individuals on select programs).
- Experience: none needed for rentals or a first flip; ground-up needs at least 1 completed build for most programs.
- Credit events (bankruptcy, foreclosure, short sale, 60+ day mortgage late in last 4 years): reviewed case by case — the Pricer won't show a price.
- Reserves: typically 3–6 months of payments in verified funds, more for foreign nationals.
- Bridgepoint's minimum to market is 620; we don't pursue sub-620 files.

WHERE WE LEND / WHAT WE DON'T FINANCE:
- We don't lend in NV, ND, SD, VT, UT, OR. Not lending in Baltimore City, MD right now; some programs exclude Philadelphia, Detroit, Cleveland, Indianapolis and specific declining-market zips — the Pricer checks every address.
- Rural: rentals only at ~65%; no flips, bridge or ground-up.
- Declining markets: ~5% less leverage; some programs don't lend.
- Appraisals: lender-ordered is standard; transfers accepted on select programs (answer "Existing appraisal to transfer?" in the Pricer).
- Not financed: owner-occupied/primary homes, consumer-purpose loans, vacant land with no construction plan, mid-construction ground-up, hotels.

PRICER ANSWERS (what the questions mean): Transaction = purchase / rate-term refi / cash-out. Townhomes & PUDs = SFR. Declining market = per appraisal/area data. Plans ready (ground-up) = stamped plans, permits imminent → bigger land advance. Months owned / rehab completed matter on refinances (10+ months = sized on today's value). Rent, taxes, insurance, HOA set the DSCR. Longer prepay = lower rate. Citizenship options: US Citizen, Permanent Resident, Non-Permanent Resident (visa), Foreign National, ITIN. Experience = documented completed deals in 3 years; ground-up asks for ground-up builds specifically. Credit event in 4 years = answer honestly.
`;

export const INTERNAL_KB = `
INTERNAL LENDER MAP — STAFF ONLY (Joe, Fiore, Erika). Never repeat lender names to anyone else.
Live engines: RCN, Velocity, NextRes. Measured models: Kiavi, A&D (refreshed daily), LEND, Constructive (V7 workbook).

ROUTING: Fix & Flip: RCN, Kiavi, LEND, Constructive, NextRes (Velocity = 75% of as-is only, no rehab funding). Bridge: RCN, Kiavi, LEND (Bridge Limited), Velocity (Flex I/O), Constructive, NextRes. Ground-up: RCN (US citizens only), LEND, Constructive (3+ builds), NextRes; Kiavi not priced. DSCR 1–4: A&D (best rates), Kiavi, RCN, Velocity, Constructive, NextRes (no MD); LEND DSCR not used. STR: RCN exact, A&D, Constructive (SFR/PUD), NextRes; Kiavi & Velocity = "confirm". 5+: RCN 5–9 units at 700+, Velocity, NextRes 5–50. Mixed-use: Velocity (rental) and NextRes (engine decides) ONLY — RCN and LEND do NO mixed-use, any program (Joe 10/8, RCN AE). Commercial: Velocity only. Portfolio/blanket: RCN only. Foreign national rental: RCN, A&D (75%), Velocity (65% no credit), Constructive (US entity). ITIN: A&D (700+, 70%). Visa: RCN, A&D (700+), Velocity, Constructive (rentals), NextRes.

FIX & FLIP / BRIDGE:
- Kiavi: 680+; 90% LTC, 75% ARV (70% in FL under 720); bridge 70%, 75% at 720+; $100k–$1M; 3+ flips = Pro pricing; rehab to $300k (35% of price / $200k under 720); refi sized on purchase price; no FL condos; entity only; no rural; not approved in AZ CA ID MN NC ND NE NJ NV NY OR SD UT VT.
- LEND: 660 (700 for top tiers, cash-out, bridge); 95% LTC at 7+ deals, 75% ARV; bridge 70%/75% at 5+ deals; $100k–$3M; structural +0.25% & 2+ deals; cash-out +1.00%, 78% of cost; seasoned 10+ months = current value; Bridge Limited 3+ deals; no appraisal transfers; no mixed-use; not in AR ND NH SD VT (case-by-case AK HI Detroit Indy Cleveland Baltimore Philly).
- RCN: 650; live engine (~90% LTC, 75% ARV); $75k–$2M ($250k–$3M 5+ units); no mixed-use; no rural; zip overlays; no appraisal transfers.
- Constructive: 680; V7 bands; light rehab 11+ band $20k–$150k rehab, 700+, SFR purchase; NY -15%, FN/cash-out -5% (not stacked); ARV 115%+ of cost; no rural/declining; not in AZ CA MN UT ND SD NV; $7,500 min equity.
- NextRes: live engine; prices Baltimore City F&F (confirm address); "Commercial Rehab and Construction" program prices mixed-use rehab; NextRes RTL price is a discount price (96 = 4 pts cost).
- Velocity Flex I/O: 675; 75% of purchase/as-is; 24-mo IO; borrower pays all rehab (ARV Pro discontinued); no 5+, no ground-up.

GROUND-UP: LEND 660 (700 top), up to 95% LTC by tier, needs 1+ completed build. RCN 650, US citizens only, ARV $175k+, $100k–$2M, takes first-time builders at ~+0.50% rate. Constructive 700, 3+ builds, 85/90% LTC, 70% ARV, land advance 50% (65–70% with permit-ready plans), FL/TX -5%, SFR/2–4/PUD. NextRes: no mixed-use ground-up.

RENTALS: A&D (DSCR only) 620 (700 visa), FN/ITIN/NP/STR priced, DSCR<1 layered limits, sub-700 cash-out limits, no Philadelphia County/Baltimore City. Kiavi rental 660, 80% for 700+ SFR purchase at 1.10 DSCR, $100k–$1.5M, cash-out max $500k, entity only, no 5+/rural. RCN 650: STR 80% of STR rent, 75% max; 5–9 units 700+, 1.25 DSCR, 70%; portfolio; ITIN declines. Velocity 30-yr/Fast50: no floor in engine (we don't market sub-620), 75% (FN 65%), $75k–$5M, asset-based, IO up to 10 yrs, 5-yr step-down prepay. Constructive DSCR 680, no mixed-use/land, no FN STR, not in AZ CA MN UT (ID for DSCR), 5–8 units not priced. NextRes 5–50 units, no MD DSCR.

COMP & FEES: Only Joe and Fiore use YSP; never with A&D. A&D: lender-paid 2.75% or borrower-paid; $1,595 UW. Kiavi: our pts max 3, ours + Kiavi max 5%; YSP up to 2 pts F&F, 1 pt rentals. RCN: points only, no YSP; $1,995 closing fee. LEND: max 5 pts total; lender fee greater of $2,500 or 1% + add-ons; $1,295 processing + $500 closing. Velocity: YSP up to 2%. Borrower-facing documents say "origination" and never name a lender.

PRICER RULE: a price shown means the lender will take it at that price; exceptions get no price; unverified policies show "confirm".
`;
