/* Triage scorer: the one copy shared by the pages (window.TriageModel) and tests/parity.mjs (require).
   The maths is the exported scikit-learn pipeline: team cleaning rules → StandardScaler → one-hot → logistic regression.
   Do not change it without re-running `node tests/parity.mjs`. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TriageModel = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LANE = {decline: "Auto-decline", review: "Analyst review", human: "Analyst only · new to credit"};
  const NUM_LABEL = {credit_score: "Credit score", is_ntc: "New to credit", foir: "FOIR", loan_to_income: "Loan ÷ annual income",
    delinquencies_24m: "Late payments (24m)", num_active_loans: "Active loans", years_in_current_job: "Years in job",
    age: "Age", tenure_months: "Tenure", city_tier: "City tier"};
  const REQUIRED = ["age", "employment_type", "years_in_current_job", "monthly_income", "existing_emi", "credit_score", "num_active_loans",
    "delinquencies_24m", "loan_purpose", "loan_amount", "tenure_months", "proposed_emi", "city_tier"];

  const isBlank = v => v === null || v === undefined || v === "" || isNaN(v);

  // EMI at 14% p.a., rounded to ₹100, as in the bank's data
  function emi(amount, months) { const r = 0.14 / 12, f = Math.pow(1 + r, months); return Math.round(amount * r * f / (f - 1) / 100) * 100; }

  // Lanes. The model never approves: auto-decline needs p ≥ threshold AND a bureau score.
  // New-to-credit applicants go to "analyst only" when the policy routes them there, otherwise to the normal analyst queue.
  function laneOf(p, ntc, policy) {
    if (ntc) return policy.route_ntc ? "human" : "review";
    return p >= policy.threshold ? "decline" : "review";
  }

  function create(MODEL) {
    // Cleaning rules (notebook Step 5.1): incomes above ₹6,00,000 are annual (÷12); blank income → employment-type median;
    // blank credit score → new to credit, filled with the median only inside the model.
    function prepare(raw) {
      const r = {...raw};
      let inc = r.monthly_income;
      if (isBlank(inc)) { inc = MODEL.income_fill_by_employment[r.employment_type] ?? 50000; r.income_filled = true; }
      inc = +inc; if (inc > 600000) { inc = inc / 12; r.income_annual_fixed = true; }
      r.monthly_income = inc;
      const blank = isBlank(r.credit_score);
      r.is_ntc = blank ? 1 : 0;
      r.credit_score_model = blank ? MODEL.credit_score_fill : +r.credit_score;
      r.foir = (+r.existing_emi + +r.proposed_emi) / inc;
      r.loan_to_income = +r.loan_amount / (inc * 12);
      return r;
    }

    function score(raw) {
      const r = prepare(raw);
      let z = MODEL.intercept; const contrib = [];
      for (const f of MODEL.numeric) {
        const x = f.name === "credit_score" ? r.credit_score_model : +r[f.name];
        const c = f.coef * (x - f.mean) / f.scale; z += c;
        contrib.push({key: f.name, label: NUM_LABEL[f.name], c, x});
      }
      for (const f of MODEL.categorical) {
        const c = f.levels[r[f.name]] ?? 0; z += c;
        contrib.push({key: f.name, label: (f.name === "employment_type" ? "Job: " : "Purpose: ") + r[f.name], c});
      }
      return {p: 1 / (1 + Math.exp(-z)), r, contrib};
    }

    // Threshold trade-off on the held-out test set, scaled to the bank's monthly volume.
    // Follows the lane rule: applicants without a bureau score are never counted as auto-declined.
    const T = MODEL.test;
    function stats(t) {
      let n = T.p.length, auto = 0, wrong = 0, caught = 0, decl = 0, ntc = 0, fA = 0, fN = 0, mA = 0, mN = 0, fAp = 0, mAp = 0;
      for (let i = 0; i < n; i++) {
        const a = T.p[i] >= t && !T.ntc[i];
        if (T.ntc[i]) ntc++;
        if (T.y[i] === 1) decl++;
        if (a) { auto++; if (T.y[i] === 0) wrong++; else caught++; }
        if (T.female[i]) { fN++; if (a) fA++; if (T.y[i] === 0) fAp++; } else { mN++; if (a) mA++; if (T.y[i] === 0) mAp++; }
      }
      const share = auto / n, apps = share * MODEL.monthly_apps;
      return {share, wrongRate: auto ? wrong / auto : 0, caught: caught / decl, apps, hours: apps * MODEL.minutes_per_review / 60, good: apps * (auto ? wrong / auto : 0),
              ntcShare: ntc / n, f: fA / fN, m: mA / mN, fAp: fAp / fN, mAp: mAp / mN};
    }

    return {MODEL, prepare, score, stats, laneOf, emi, LANE, NUM_LABEL, REQUIRED,
      defaultPolicy: () => ({threshold: MODEL.threshold, route_ntc: true})};
  }

  return {create, laneOf, emi, LANE, NUM_LABEL, REQUIRED};
});
