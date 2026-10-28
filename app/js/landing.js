/* Landing page: the hero mini-demo (one example application scored live with the real model)
   and the three headline numbers, computed from the same test-set predictions as the Threshold view. */
(function () {
  "use strict";
  const MODEL = JSON.parse(document.getElementById("model-data").textContent);
  const M = window.TriageModel.create(MODEL);
  const policy = M.defaultPolicy();
  const F = id => document.getElementById(id);
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  // The borderline example from the app's Score view
  const BASE = {age: 31, employment_type: "Salaried", years_in_current_job: 2.4, city_tier: 2, monthly_income: 45000, num_active_loans: 2,
    loan_purpose: "Debt Consolidation", loan_amount: 320000, tenure_months: 36};

  function render() {
    const ntc = F("dNtc").checked;
    F("dScore").disabled = ntc;
    F("dScoreOut").textContent = ntc ? "none" : F("dScore").value;
    const raw = {...BASE, proposed_emi: M.emi(BASE.loan_amount, BASE.tenure_months), existing_emi: +F("dEmi").value,
      delinquencies_24m: +F("dLate").value, credit_score: ntc ? null : +F("dScore").value};
    const {p, r} = M.score(raw), lane = M.laneOf(p, r.is_ntc, policy), conf = Math.round(p * 100);
    F("dLane").className = "lane " + lane;
    F("dTag").textContent = M.LANE[lane];
    if (lane === "decline") { F("dTitle").textContent = "Decline automatically"; F("dText").textContent = `The model is ${conf}% confident the credit team would decline, above the 0.90 threshold. No analyst time needed.`; }
    else if (lane === "human") { F("dTitle").textContent = "Send to an analyst. The model does not decide."; F("dText").textContent = `No credit history, so a person always reviews it. (Model confidence for reference: ${conf}%.)`; }
    else { F("dTitle").textContent = "Send to an analyst"; F("dText").textContent = `The model is ${conf}% confident of a decline. That is below the 0.90 threshold, so this application needs judgement.`; }
    F("dProb").textContent = conf + "%";
    F("dFill").style.width = (p * 100).toFixed(1) + "%";
    F("dFill").style.background = lane === "decline" ? css("--decline") : lane === "human" ? css("--human") : css("--accent");
  }
  F("demoForm").addEventListener("input", render);
  F("demoForm").addEventListener("submit", e => e.preventDefault());
  document.addEventListener("themechange", render);
  render();

  const s = M.stats(policy.threshold);
  F("n1").textContent = Math.round(s.apps).toLocaleString("en-IN");
  F("n1s").textContent = (s.share * 100).toFixed(1) + "%";
  F("n2").textContent = Math.round(s.hours).toLocaleString("en-IN");
  F("n3").textContent = (s.wrongRate * 100).toFixed(1) + "%";
  F("footVer").textContent = MODEL.version;

  // Signed in already? Supabase keeps the session under sb-<project>-auth-token. Only swaps the buttons; /app re-checks.
  let signedIn = false;
  try { signedIn = Object.keys(localStorage).some(k => /^sb-.+-auth-token$/.test(k)); } catch (e) {}
  if (signedIn) ["navSignedIn", "ctaSignedIn", "ctaSignedIn2"].forEach(id => { F(id).hidden = false; });
  if (signedIn) ["navSignedOut", "ctaSignedOut", "ctaSignedOut2"].forEach(id => { F(id).hidden = true; });
  if (new URLSearchParams(location.search).get("account") === "deleted") F("goneBanner").hidden = false;
})();
