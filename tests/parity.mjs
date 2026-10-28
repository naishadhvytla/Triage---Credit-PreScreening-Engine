// Parity test: the browser scorer (app/js/model.js) must reproduce scikit-learn's predict_proba
// on the 300 held-out rows in model/parity_fixture.json to within 1e-8.
//   node tests/parity.mjs
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
const TriageModel = require("../app/js/model.js");
const MODEL = JSON.parse(readFileSync(new URL("app/model.json", root)));
const fixture = JSON.parse(readFileSync(new URL("model/parity_fixture.json", root)));

const TOL = 1e-8;
const m = TriageModel.create(MODEL);
let worst = 0, worstId = null, fails = 0, ntc = 0;
for (const row of fixture) {
  const {p, r} = m.score(row);
  const d = Math.abs(p - row.sk_proba);
  if (r.is_ntc) ntc++;
  if (!(d <= TOL)) { fails++; if (fails <= 5) console.error(`✗ ${row.application_id}: js=${p} sklearn=${row.sk_proba} |Δ|=${d}`); }
  if (d > worst || Number.isNaN(d)) { worst = d; worstId = row.application_id; }
}

// The lane rule: never auto-decline without a bureau score, whatever the threshold
const noScore = {...fixture[0], credit_score: null};
const lanes = [0.5, 0.9, 0.99].map(t => m.laneOf(0.999, m.score(noScore).r.is_ntc, {threshold: t, route_ntc: false}));
const laneOk = lanes.every(l => l === "review") && m.laneOf(0.95, 0, {threshold: 0.9, route_ntc: true}) === "decline"
  && m.laneOf(0.95, 1, {threshold: 0.9, route_ntc: true}) === "human" && m.laneOf(0.89, 0, {threshold: 0.9, route_ntc: true}) === "review";

// Cleaning rules
const c1 = m.prepare({...fixture[0], monthly_income: 720000});
const c2 = m.prepare({...fixture[0], monthly_income: null, employment_type: "Gig / Contract"});
const cleanOk = c1.monthly_income === 60000 && c1.income_annual_fixed && c2.monthly_income === MODEL.income_fill_by_employment["Gig / Contract"] && c2.income_filled
  && m.prepare(noScore).credit_score_model === MODEL.credit_score_fill;

console.log(`parity: ${fixture.length - fails}/${fixture.length} rows within ${TOL} (worst |Δ| ${worst.toExponential(2)} at ${worstId}; ${ntc} new-to-credit rows)`);
console.log(`lanes: ${laneOk ? "ok" : "FAILED"} · cleaning rules: ${cleanOk ? "ok" : "FAILED"}`);
if (fails || !laneOk || !cleanOk || fixture.length !== 300) process.exit(1);
