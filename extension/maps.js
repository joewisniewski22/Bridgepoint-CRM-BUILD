// Per-lender maps: which of the lender's screens we recognize, which package
// value goes in which field, and which document categories go in which upload
// slot. Built one lender at a time in a mapping session (staff logged in, test
// data only). A lender with no pages yet still gets the panel's copy-and-
// download view.
//
// Page shape:
//   { name, match: () => boolean,
//     fields: [{ label | selector, value: "dotted.package.path" | (pkg)=>value, fmt?: money|pct|int|mdy|ymd|upper, radio?: true, contains?: true }],
//     uploads: [{ label, category | categories:[], slot: { label | selector } }] }
// Package paths: loan.*, property.*, borrower.entityName, borrower.guarantor.*, borrower.coGuarantor.*, trackRecord[], documents[]
window.BP_MAPS = {
  RCN: { host: /commerciallendingservicesllc\.com$/, pages: [] },
  Kiavi: { host: /kiavi\.com$/, pages: [] },
  "A&D": { host: /admortgage\.com$/, pages: [] },
  Constructive: { host: null, pages: [] },
  NextRes: { host: null, pages: [] },
};
