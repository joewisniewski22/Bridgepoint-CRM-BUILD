// Deploy guard (2026-10-06: one stray ")" in index.html blanked the whole CRM for
// every user). Vercel runs this as the build step; any JavaScript syntax error in
// the CRM page or the extension fails the build, so the last good version stays live.
const fs = require("fs");
const vm = require("vm");
let failed = false;

function check(code, label, lineOffset) {
  try {
    new vm.Script(code, { filename: label, lineOffset });
  } catch (e) {
    failed = true;
    const m = /:(\d+)/.exec(String(e.stack).split("\n")[0]);
    console.error("SYNTAX ERROR in " + label + (m ? " near line " + m[1] : "") + ": " + e.message);
  }
}

const html = fs.readFileSync("index.html", "utf8");
const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(html))) {
  if (/application\/(ld\+)?json/i.test(m[1])) continue;
  const startLine = html.slice(0, m.index).split("\n").length - 1;
  check(m[2], "index.html", startLine);
}
for (const f of ["sw.js"].concat(fs.readdirSync("extension").filter((n) => n.endsWith(".js")).map((n) => "extension/" + n))) {
  if (fs.existsSync(f)) check(fs.readFileSync(f, "utf8"), f, 0);
}
if (failed) { console.error("Deploy blocked: fix the syntax error above."); process.exit(1); }
console.log("Syntax check passed.");
