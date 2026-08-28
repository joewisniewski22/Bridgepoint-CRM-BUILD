$ErrorActionPreference = "Stop"
$dir = "C:\Users\Joseph Wisniewski\Documents\Bridgepoint-CRM-BUILD\supabase"
$json = Get-Content "$dir\_state.json" -Raw -Encoding UTF8 | ConvertFrom-Json

function SqlStr($v) {
  if ($null -eq $v) { return "null" }
  $s = $v.ToString()
  $s = $s -replace "'", "''"
  return "'$s'"
}
function SqlNum($v) {
  if ($null -eq $v) { return "null" }
  return $v
}
function SqlBool($v) {
  if ($null -eq $v) { return "false" }
  if ($v) { return "true" } else { return "false" }
}
function SqlJson($v) {
  if ($null -eq $v) { return "'[]'::jsonb" }
  $arr = @($v)
  $j = ConvertTo-Json -InputObject $arr -Depth 20 -Compress
  $j = $j -replace "'", "''"
  return "'$j'::jsonb"
}
function SqlDate($v) {
  if ([string]::IsNullOrEmpty($v)) { return "null" }
  return "'$v'"
}

$out = New-Object System.Text.StringBuilder
[void]$out.AppendLine("-- Generated seed data. Run AFTER 003_leads_schema.sql.")
[void]$out.AppendLine("")

# market_rates
[void]$out.AppendLine("insert into public.market_rates (key, label, previous, current, updated_at) values")
$rateKeys = $json.marketRates.PSObject.Properties.Name
$rateLines = @()
foreach ($k in $rateKeys) {
  $r = $json.marketRates.$k
  $rateLines += "  ($(SqlStr $k), $(SqlStr $r.label), $(SqlNum $r.previous), $(SqlNum $r.current), $(SqlDate $r.updatedAt))"
}
[void]$out.AppendLine(($rateLines -join ",`n") + ";")
[void]$out.AppendLine("")

# leads (must be inserted before notifications, which reference lead ids via FK)
$cols = @(
  "id","name","email","phone","source","loan_type","stage","status","assigned_to","created_at",
  "entity_type","credit_score","experience_deals","liquidity","property_address","property_type",
  "purchase_price","arv","rehab_budget","rent_estimate","loan_amount","ltv","rate","term_months",
  "exit_strategy","close_date","next_follow_up","next_follow_up_note","points_charged",
  "created_at_ts","first_attempt_at","application_sent_at","application_taken_by_phone",
  "application_taken_at","appraisal_ordered","appraisal_ordered_at","title_ordered","title_ordered_at",
  "preapproval_sent_at","termsheet_sent_at","credit_ordered_at","last_contact_at",
  "call_attempts","activity","documents","third_parties"
)
[void]$out.AppendLine("insert into public.leads (" + ($cols -join ", ") + ") values")
$leadLines = @()
foreach ($l in $json.leads) {
  $vals = @(
    (SqlStr $l.id), (SqlStr $l.name), (SqlStr $l.email), (SqlStr $l.phone), (SqlStr $l.source),
    (SqlStr $l.loanType), (SqlStr $l.stage), (SqlStr $l.status), (SqlStr $l.assignedTo), (SqlDate $l.createdAt),
    (SqlStr $l.entityType), (SqlNum $l.creditScore), (SqlNum $l.experienceDeals), (SqlNum $l.liquidity),
    (SqlStr $l.propertyAddress), (SqlStr $l.propertyType),
    (SqlNum $l.purchasePrice), (SqlNum $l.arv), (SqlNum $l.rehabBudget), (SqlNum $l.rentEstimate),
    (SqlNum $l.loanAmount), (SqlNum $l.ltv), (SqlNum $l.rate), (SqlNum $l.termMonths),
    (SqlStr $l.exitStrategy), (SqlDate $l.closeDate), (SqlDate $l.nextFollowUp), (SqlStr $l.nextFollowUpNote), (SqlNum $l.pointsCharged),
    (SqlDate $l.createdAtTs), (SqlDate $l.firstAttemptAt), (SqlDate $l.applicationSentAt), (SqlBool $l.applicationTakenByPhone),
    (SqlDate $l.applicationTakenAt), (SqlBool $l.appraisalOrdered), (SqlDate $l.appraisalOrderedAt), (SqlBool $l.titleOrdered), (SqlDate $l.titleOrderedAt),
    (SqlDate $l.preapprovalSentAt), (SqlDate $l.termsheetSentAt), (SqlDate $l.creditOrderedAt), (SqlDate $l.lastContactAt),
    (SqlJson $l.callAttempts), (SqlJson $l.activity), (SqlJson $l.documents), (SqlJson $l.thirdParties)
  )
  $leadLines += "  (" + ($vals -join ", ") + ")"
}
[void]$out.AppendLine(($leadLines -join ",`n") + ";")
[void]$out.AppendLine("")

# notifications (after leads, since lead_id has a foreign key to leads.id)
if ($json.notifications.Count -gt 0) {
  [void]$out.AppendLine("insert into public.notifications (id, to_user_id, lead_id, kind, text, date, read) values")
  $notifLines = @()
  foreach ($n in $json.notifications) {
    $notifLines += "  ($(SqlStr $n.id), $(SqlStr $n.toUserId), $(SqlStr $n.leadId), $(SqlStr $n.kind), $(SqlStr $n.text), $(SqlDate $n.date), $(SqlBool $n.read))"
  }
  [void]$out.AppendLine(($notifLines -join ",`n") + ";")
}

[System.IO.File]::WriteAllText("$dir\004_seed_data_v2.sql", $out.ToString(), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Wrote $dir\004_seed_data_v2.sql"
