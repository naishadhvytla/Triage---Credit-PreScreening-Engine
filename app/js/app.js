/* /app: Score, Threshold, Batch, History, Model card + account menu. Signed-in users only.
   Scoring runs in the browser (js/model.js). Supabase stores the user's policy, saved scorings, batches and files. */
(function () {
  "use strict";
  const B = window.TriageBackend;
  const MODEL = JSON.parse(document.getElementById("model-data").textContent);
  const SAMPLE_CSV = JSON.parse(document.getElementById("sample-data").textContent);
  const M = window.TriageModel.create(MODEL);
  const {LANE, NUM_LABEL, REQUIRED} = M;
  const LIMIT = {scorings: 50, batches: 5};
  const MAX_FILE = 10 * 1024 * 1024;
  const BUCKET = "intake";

  const F = id => document.getElementById(id);
  const fmtINR = v => "₹" + Math.round(v).toLocaleString("en-IN");
  const pct = (v, d = 1) => (v * 100).toFixed(d) + "%";
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const fmtDate = s => new Date(s).toLocaleString("en-IN", {day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"});
  const describe = p => `${(+p.threshold).toFixed(2)} · new to credit → ${p.route_ntc ? "analyst only" : "analyst queue"}`;

  let user = null, leaving = false;
  let policy = M.defaultPolicy();      // the saved policy in force (default until loaded)
  const hist = {loaded: false, loading: null, scorings: [], batches: [], filter: "all", q: "", confirming: null};

  // ---------- small UI helpers ----------
  function status(id, text, kind) { const el = F(id); el.className = "status" + (kind ? " " + kind : ""); el.innerHTML = text || ""; }
  function busy(btn, on, label) {
    if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.setAttribute("aria-busy", "true"); btn.innerHTML = `<span class="spin" aria-hidden="true"></span>${esc(label)}`; }
    else { btn.disabled = false; btn.removeAttribute("aria-busy"); if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }
  let toastT = null;
  function toast(text) { const t = F("toast"); t.textContent = text; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3200); }
  const historyLink = '<button type="button" class="linkbtn" data-goto="history">Open History</button>';
  function sysBanner(text) { const b = F("sysBanner"); b.textContent = text || ""; b.hidden = !text; }
  function dbError(e) {   // a missing schema is a setup problem worth a page-wide banner
    const msg = B.friendly(e);
    if (/isn't set up yet/.test(msg)) sysBanner(msg + " Saving is unavailable until then; scoring still works.");
    return msg;
  }

  // ---------- tabs (arrow keys move between tabs) ----------
  const views = ["score", "threshold", "batch", "report", "history", "model"];
  function show(v, focusTab) {
    if (!views.includes(v)) v = "score";
    views.forEach(x => {
      F("v-" + x).hidden = x !== v;
      const t = F("t-" + x); t.setAttribute("aria-selected", x === v); t.tabIndex = x === v ? 0 : -1;
    });
    if (focusTab) F("t-" + v).focus();
    try { localStorage.setItem("triage-view", v); } catch (e) {}
    if (location.hash !== "#" + v) history.replaceState(null, "", "#" + v);
    if (v === "threshold") drawThreshold();
    if (v === "history") loadHistory();
    if (v === "report") renderReport();
  }
  document.querySelectorAll("nav.tabs button").forEach(b => b.addEventListener("click", () => show(b.dataset.view)));
  F("tabs").addEventListener("keydown", e => {
    const i = views.indexOf(document.activeElement.dataset.view);
    if (i < 0) return;
    const to = {ArrowRight: (i + 1) % views.length, ArrowLeft: (i - 1 + views.length) % views.length, Home: 0, End: views.length - 1}[e.key];
    if (to === undefined) return;
    e.preventDefault(); show(views[to], true);
  });
  document.addEventListener("click", e => {
    const g = e.target.closest("[data-goto]");
    if (!g) return;
    closeMenu(); show(g.dataset.goto); F("main").focus({preventScroll: true});
  });

  // ---------- score view ----------
  const PRESETS = {
    decline: {age: 27, employment_type: "Gig / Contract", years_in_current_job: 0.8, city_tier: "3", monthly_income: 26000, existing_emi: 7500, credit_score: 612, ntc: false, delinquencies_24m: 4, num_active_loans: 3, loan_purpose: "Debt Consolidation", loan_amount: 300000, tenure_months: "24"},
    border: {age: 31, employment_type: "Salaried", years_in_current_job: 2.4, city_tier: "2", monthly_income: 45000, existing_emi: 7000, credit_score: 676, ntc: false, delinquencies_24m: 1, num_active_loans: 2, loan_purpose: "Debt Consolidation", loan_amount: 320000, tenure_months: "36"},
    ntc: {age: 24, employment_type: "Salaried", years_in_current_job: 1.1, city_tier: "1", monthly_income: 38000, existing_emi: 0, credit_score: "", ntc: true, delinquencies_24m: 0, num_active_loans: 0, loan_purpose: "Consumer Durables", loan_amount: 150000, tenure_months: "24"},
  };
  const FORM_KEYS = ["age", "employment_type", "years_in_current_job", "city_tier", "monthly_income", "existing_emi", "credit_score", "delinquencies_24m", "num_active_loans", "loan_purpose", "loan_amount", "tenure_months"];
  function fillForm(p) {
    for (const key of FORM_KEYS) if (key in p) F(key).value = p[key] === null || p[key] === undefined ? "" : String(p[key]);
    F("ntc").checked = !!p.ntc || (!("ntc" in p) && p.credit_score === null);
    renderScore();
  }
  document.querySelectorAll("[data-preset]").forEach(b => b.addEventListener("click", () => { F("openBanner").hidden = true; fillForm(PRESETS[b.dataset.preset]); }));

  function readForm() {
    const ntc = F("ntc").checked;
    F("credit_score").disabled = ntc;
    const amount = +F("loan_amount").value || 0, ten = +F("tenure_months").value;
    const pe = amount > 0 ? M.emi(amount, ten) : 0; F("proposed_emi").value = pe;
    const inc = F("monthly_income").value;
    return {age: +F("age").value, employment_type: F("employment_type").value, years_in_current_job: +F("years_in_current_job").value,
      city_tier: +F("city_tier").value, monthly_income: inc === "" ? null : +inc, existing_emi: +F("existing_emi").value || 0,
      credit_score: ntc ? null : (F("credit_score").value === "" ? null : +F("credit_score").value),
      delinquencies_24m: +F("delinquencies_24m").value || 0, num_active_loans: +F("num_active_loans").value || 0,
      loan_purpose: F("loan_purpose").value, loan_amount: amount, tenure_months: ten, proposed_emi: pe};
  }

  function renderScore() {
    const raw = readForm(); const {p, r, contrib} = M.score(raw); const t = policy.threshold;
    const lane = M.laneOf(p, r.is_ntc, policy);
    F("incHint").textContent = r.income_filled ? `Blank, so the ${r.employment_type} median (${fmtINR(r.monthly_income)}) is used` :
      r.income_annual_fixed ? `Above ₹6 lakh: treated as annual, so ${fmtINR(r.monthly_income)} a month` : "Leave blank to use the median for this job type";
    const card = F("laneCard"); card.className = "lane " + lane;
    F("laneTag").querySelector("span").textContent = LANE[lane];
    const conf = Math.round(p * 100), wr = M.stats(t).wrongRate;
    const riskLine = wr <= 0.05 ? "At this threshold fewer than 5 in 100 automatic declines are applicants the bank would have approved."
      : `At this threshold about ${Math.round(wr * 100)} in 100 automatic declines are applicants the bank would have approved, above its 5% limit.`;
    if (lane === "decline") { F("laneTitle").textContent = "Decline automatically"; F("laneText").textContent = `The model is ${conf}% confident the credit team would decline this application, above the ${t.toFixed(2)} threshold. ${riskLine}`; }
    else if (lane === "human") { F("laneTitle").textContent = "Send to an analyst. The model does not decide."; F("laneText").textContent = `No credit history. The model is barely better than a coin toss for new-to-credit applicants, so they always get a human review. (Model confidence for reference: ${conf}%.)`; }
    else if (r.is_ntc) { F("laneTitle").textContent = "Send to an analyst"; F("laneText").textContent = `No credit history, so the model never auto-declines. Your policy sends new-to-credit applicants to the normal analyst queue. (Model confidence for reference: ${conf}%.)`; }
    else { F("laneTitle").textContent = "Send to an analyst"; F("laneText").textContent = `The model is ${conf}% confident of a decline. That is below the ${t.toFixed(2)} threshold, so this application needs judgement. The model never approves on its own.`; }
    F("probVal").textContent = conf + "%";
    F("probFill").style.width = (p * 100).toFixed(1) + "%";
    F("probFill").style.background = lane === "decline" ? css("--decline") : lane === "human" ? css("--human") : css("--accent");
    F("probTick").style.left = (t * 100) + "%"; F("probTickL").style.left = (t * 100) + "%"; F("probTickL").textContent = "threshold " + t.toFixed(2);

    F("rFoir").textContent = pct(r.foir, 0);
    const fe = F("rFoirE"); if (r.foir > .55) { fe.textContent = "Above 55%: approvals collapse"; fe.className = "flag-bad"; } else if (r.foir > .5) { fe.textContent = "50–55%: exception band"; fe.className = "flag-warn"; } else { fe.textContent = "Within a 50% limit"; fe.className = "flag-ok"; }
    F("rLti").textContent = r.loan_to_income.toFixed(2) + "×"; F("rLtiE").textContent = `${fmtINR(r.monthly_income)} a month`;
    const se = F("rScoreE");
    if (r.is_ntc) { F("rScore").textContent = "None"; se.textContent = "New to credit"; se.className = "flag-warn"; }
    else { F("rScore").textContent = r.credit_score; if (r.credit_score < 650) { se.textContent = "Below the 650 floor"; se.className = "flag-bad"; } else { se.textContent = "Above the 650 floor"; se.className = "flag-ok"; } }

    const top = contrib.filter(c => Math.abs(c.c) > 0.005).sort((a, b) => Math.abs(b.c) - Math.abs(a.c)).slice(0, 6);
    const max = Math.max(0.6, ...top.map(c => Math.abs(c.c))) * 1.08;
    F("drivers").innerHTML = top.map(c => {
      const w = Math.abs(c.c) / max * 50; const pos = c.c > 0;
      let v = ""; if (c.key === "foir") v = pct(c.x, 0); else if (c.key === "credit_score") v = r.is_ntc ? "none" : c.x; else if (c.key === "loan_to_income") v = c.x.toFixed(2) + "×"; else if (c.x !== undefined) v = c.x;
      return `<div class="drv"><div class="lbl"><b>${esc(c.label)}</b><span>${esc(v)}</span></div><div class="dbar" title="${c.c.toFixed(2)}"><i style="${pos ? "left:50%" : "right:50%"};width:${w}%;background:var(${pos ? "--series-2" : "--accent"})"></i></div></div>`;
    }).join("");
    return {raw, p, lane};
  }
  F("appForm").addEventListener("input", () => { renderScore(); status("saveStatus", ""); });
  F("appForm").addEventListener("submit", e => e.preventDefault());

  async function saveScoring() {
    const btn = F("saveScore");
    if (btn.disabled) return;
    const {raw, p, lane} = renderScore();
    status("saveStatus", "");
    busy(btn, true, "Saving…");
    try {
      const row = {user_id: user.id, inputs: {...raw, ntc: F("ntc").checked}, probability: p, lane, threshold: policy.threshold,
        model_version: MODEL.version, note: F("note").value.trim() || null};
      const {error} = await B.client.from("scorings").insert(row);
      if (error) throw error;
      F("note").value = "";
      hist.loaded = false;
      status("saveStatus", `Saved: ${esc(LANE[lane])}, ${Math.round(p * 100)}% decline confidence. ${historyLink}`, "ok");
      refreshUsage();
    } catch (e) {
      const msg = dbError(e);
      status("saveStatus", esc(msg) + (/Delete one/.test(msg) ? " " + historyLink : ""), "bad");
    } finally { busy(btn, false); }
  }
  F("saveScore").addEventListener("click", saveScoring);
  F("note").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); saveScoring(); } });
  F("openBannerClose").addEventListener("click", () => { F("openBanner").hidden = true; });

  // ---------- threshold view ----------
  const THR_GRID = Array.from({length: 50}, (_, i) => +(0.5 + i * 0.01).toFixed(2));
  const draft = () => ({threshold: +(+F("thr").value).toFixed(2), route_ntc: F("exNtc").checked});
  let confirmBreak = false;

  function paintPolicyBar() {
    const d = draft(), same = d.threshold === +policy.threshold && d.route_ntc === policy.route_ntc;
    F("polNow").textContent = describe(policy);
    F("polChip").textContent = `policy ${(+policy.threshold).toFixed(2)} · NTC → ${policy.route_ntc ? "analyst" : "queue"}`;
    const btn = F("savePolicy");
    if (!btn.getAttribute("aria-busy")) btn.disabled = same;
    F("resetPolicy").hidden = same;
    if (same || !confirmBreak) { confirmBreak = false; btn.textContent = "Save as my policy"; btn.className = "btn primary"; }
    const ntc = pct(M.stats(d.threshold).ntcShare);
    F("ntcNote").textContent = d.route_ntc
      ? `New-to-credit applicants (${ntc} of the test set) are never auto-declined and go to a dedicated analyst-only lane.`
      : `New-to-credit applicants (${ntc} of the test set) are never auto-declined. With this off they join the normal analyst queue.`;
  }

  function drawThreshold() {
    const t = +F("thr").value; F("thrOut").textContent = t.toFixed(2);
    const s = M.stats(t);
    F("kPct").textContent = pct(s.share); F("kPctE").textContent = `catches ${pct(s.caught, 0)} of all declines`;
    F("kApps").textContent = Math.round(s.apps).toLocaleString("en-IN");
    F("kHrs").textContent = "~" + Math.round(s.hours);
    F("kWrong").textContent = pct(s.wrongRate);
    F("kGood").textContent = "~" + Math.round(s.good);
    const ok = s.wrongRate <= 0.05 && s.share > 0;
    const pill = F("rulePill"); pill.className = "pill " + (ok ? "ok" : "bad"); pill.textContent = ok ? "Within the 5% limit" : (s.share > 0 ? "Breaks the 5% limit" : "No auto-declines");
    F("fairBody").innerHTML = `<tr><td>Female applicants</td><td class="n">${pct(s.f)}</td><td class="n">${pct(s.fAp)}</td></tr><tr><td>Male applicants</td><td class="n">${pct(s.m)}</td><td class="n">${pct(s.mAp)}</td></tr><tr><td>Gap (F − M)</td><td class="n">${((s.f - s.m) * 100).toFixed(1)} pts</td><td class="n">${((s.fAp - s.mAp) * 100).toFixed(1)} pts</td></tr>`;
    F("thrBody").innerHTML = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95].map(x => { const q = M.stats(x), good = q.wrongRate <= 0.05;
      return `<tr class="${Math.abs(x - t) < 0.001 ? "cur" : ""}"><td class="num">${x.toFixed(2)}</td><td class="n">${pct(q.share)}</td><td class="n">${pct(q.wrongRate)}</td><td class="n">${pct(q.caught)}</td><td class="n">${Math.round(q.apps)}</td><td class="n">${Math.round(q.hours)}</td><td><span class="tag ${good ? "review" : "decline"}">${good ? "Meets" : "Breaks"}</span></td></tr>`; }).join("");
    drawChart(t);
    paintPolicyBar();
  }
  let chartPts = [];
  function drawChart(t) {
    const W = 640, H = 300, L = 44, R = 14, Tp = 14, Bt = 36, svg = F("chart");
    const xs = v => L + (v - 0.5) / (0.99 - 0.5) * (W - L - R), ys = v => Tp + (1 - v / 50) * (H - Tp - Bt);
    chartPts = THR_GRID.map(x => { const q = M.stats(x); return {x, a: q.share * 100, w: q.wrongRate * 100}; });
    const ink = css("--muted"), line = css("--line"), acc = css("--accent"), s2 = css("--series-2"), surf = css("--surface");
    let g = "";
    for (const v of [0, 10, 20, 30, 40, 50]) g += `<line x1="${L}" x2="${W - R}" y1="${ys(v)}" y2="${ys(v)}" stroke="${line}"/><text x="${L - 8}" y="${ys(v) + 4}" text-anchor="end" font-size="11" fill="${ink}" font-family="IBM Plex Mono, monospace">${v}%</text>`;
    for (const v of [0.5, 0.6, 0.7, 0.8, 0.9]) g += `<text x="${xs(v)}" y="${H - Bt + 18}" text-anchor="middle" font-size="11" fill="${ink}" font-family="IBM Plex Mono, monospace">${v.toFixed(2)}</text>`;
    g += `<text x="${(L + W - R) / 2}" y="${H - 2}" text-anchor="middle" font-size="11.5" fill="${ink}">Decline-confidence threshold</text>`;
    g += `<line x1="${L}" x2="${W - R}" y1="${ys(5)}" y2="${ys(5)}" stroke="${ink}" stroke-dasharray="5 4"/><text x="${L + 6}" y="${ys(5) - 6}" font-size="11" fill="${ink}">5% limit</text>`;
    const path = k => chartPts.map((p, i) => (i ? "L" : "M") + xs(p.x).toFixed(1) + " " + ys(p[k]).toFixed(1)).join(" ");
    g += `<path d="${path("a")}" fill="none" stroke="${acc}" stroke-width="2"/><path d="${path("w")}" fill="none" stroke="${s2}" stroke-width="2"/>`;
    const cur = chartPts.reduce((a, b) => Math.abs(b.x - t) < Math.abs(a.x - t) ? b : a);
    g += `<line x1="${xs(t)}" x2="${xs(t)}" y1="${Tp}" y2="${H - Bt}" stroke="${ink}" stroke-width="1" opacity=".5"/>`;
    g += `<circle cx="${xs(cur.x)}" cy="${ys(cur.a)}" r="5" fill="${acc}" stroke="${surf}" stroke-width="2"/><circle cx="${xs(cur.x)}" cy="${ys(cur.w)}" r="5" fill="${s2}" stroke="${surf}" stroke-width="2"/>`;
    g += `<rect x="${L}" y="${Tp}" width="${W - L - R}" height="${H - Tp - Bt}" fill="transparent" id="hit"/>`;
    svg.innerHTML = g;
    const tip = F("tip");
    svg.querySelector("#hit").addEventListener("mousemove", e => {
      const b = svg.getBoundingClientRect(), vx = (e.clientX - b.left) / b.width * W;
      const v = 0.5 + (vx - L) / (W - L - R) * 0.49; const p = chartPts.reduce((a, c) => Math.abs(c.x - v) < Math.abs(a.x - v) ? c : a);
      tip.hidden = false; tip.style.left = (xs(p.x) / W * b.width) + "px"; tip.style.top = (ys(p.a) / H * b.height) + "px";
      tip.textContent = `${p.x.toFixed(2)} · ${p.a.toFixed(1)}% declined · ${p.w.toFixed(1)}% wrong`;
    });
    svg.querySelector("#hit").addEventListener("mouseleave", () => { tip.hidden = true; });
  }
  F("thr").addEventListener("input", () => { confirmBreak = false; status("polStatus", ""); drawThreshold(); });
  F("exNtc").addEventListener("change", () => { confirmBreak = false; status("polStatus", ""); drawThreshold(); });
  F("resetPolicy").addEventListener("click", () => { syncPolicyControls(); status("polStatus", ""); drawThreshold(); });

  function syncPolicyControls() { F("thr").value = (+policy.threshold).toFixed(2); F("exNtc").checked = policy.route_ntc; }

  async function savePolicy() {
    const btn = F("savePolicy"), d = draft(), s = M.stats(d.threshold);
    if (s.wrongRate > 0.05 && !confirmBreak) {
      confirmBreak = true;
      btn.textContent = "Save anyway"; btn.className = "btn danger solid";
      status("polStatus", `At ${d.threshold.toFixed(2)}, ${pct(s.wrongRate)} of automatic declines are applicants the bank approved, above its 5% limit. Press “Save anyway” to keep it, or move the threshold.`, "warn");
      return;
    }
    busy(btn, true, "Saving…");
    try {
      const {error} = await B.client.from("policies").upsert({user_id: user.id, threshold: d.threshold, route_ntc: d.route_ntc}, {onConflict: "user_id"});
      if (error) throw error;
      policy = d; confirmBreak = false;
      status("polStatus", `Saved. Score and Batch now use ${esc(describe(policy))}.`, "ok");
      applyPolicy();
    } catch (e) { status("polStatus", esc(dbError(e)), "bad"); }
    finally { busy(btn, false); btn.removeAttribute("aria-busy"); paintPolicyBar(); }
  }
  F("savePolicy").addEventListener("click", savePolicy);

  function applyPolicy() {
    syncPolicyControls();
    renderScore();
    if (!F("v-threshold").hidden) drawThreshold(); else paintPolicyBar();
    if (current && current.isSample) runBatch(SAMPLE_CSV, "Sample batch", policy, {isSample: true});
    else if (current) paintBatchBanner();
  }

  // ---------- batch view ----------
  let current = null;   // {rows, cols, label, policy, isSample, saved}
  function runBatch(text, label, pol, meta) {
    const err = F("batchErr"); err.hidden = true;
    const res = Papa.parse(text.trim(), {header: true, dynamicTyping: true, skipEmptyLines: true});
    const cols = res.meta.fields || [];
    const missing = REQUIRED.filter(c => !cols.includes(c));
    if (missing.length) { err.hidden = false; err.textContent = `This file is missing ${missing.length} required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Use the same headers as MUC02_Credit_PreScreening_Dataset.csv.`; return null; }
    if (!res.data.length) { err.hidden = false; err.textContent = "This file has headers but no applications."; return null; }
    const rows = res.data.map((row, i) => { const s = M.score(row); return {...row, _p: s.p, _lane: M.laneOf(s.p, s.r.is_ntc, pol), _foir: s.r.foir, _inc: s.r.monthly_income, _fixed: s.r.income_annual_fixed || false, _filled: s.r.income_filled || false, _id: row.application_id ?? ("row " + (i + 1))}; });
    current = {rows, cols, label, policy: {...pol}, isSample: !!(meta && meta.isSample), saved: meta && meta.saved || null};
    renderBatch();
    return summarize(rows, cols);
  }

  function summarize(rows, cols) {
    const n = rows.length, cnt = k => rows.filter(r => r._lane === k).length;
    const out = {row_count: n, lane_counts: {decline: cnt("decline"), review: cnt("review"), human: cnt("human")}, wrong_decline_rate: null, gender_rates: null};
    if (cols.includes("decision")) { const ad = rows.filter(r => r._lane === "decline"); out.wrong_decline_rate = ad.length ? ad.filter(r => r.decision === "Approved").length / ad.length : 0; }
    if (cols.includes("gender")) {
      const g = k => { const s = rows.filter(r => r.gender === k); return s.length ? +(s.filter(r => r._lane === "decline").length / s.length).toFixed(4) : null; };
      out.gender_rates = {female: g("Female"), male: g("Male")};
    }
    return out;
  }

  function renderBatch() {
    const {rows: scored, cols, label, policy: pol} = current;
    F("dropMsg").innerHTML = `<b>${esc(label)}:</b> ${scored.length.toLocaleString("en-IN")} applications scored.`;
    F("batchThr").textContent = `Threshold ${(+pol.threshold).toFixed(2)} · new to credit → ${pol.route_ntc ? "analyst only" : "analyst queue"}`;
    const n = scored.length, cnt = k => scored.filter(r => r._lane === k).length;
    const lanes = [["decline", "--decline"], ["review", "--accent"], ["human", "--human"]].map(([k, c]) => ({k, c, v: cnt(k)}));
    F("laneBar").innerHTML = lanes.filter(l => l.v).map(l => `<i style="width:${l.v / n * 100}%;background:var(${l.c})" title="${LANE[l.k]}"></i>`).join("");
    F("laneBody").innerHTML = lanes.map(l => `<tr data-lane="${l.k}"><td><span class="tag ${l.k}">${LANE[l.k]}</span></td><td class="n">${l.v}</td><td class="n">${pct(l.v / n)}</td></tr>`).join("");
    const dec = cnt("decline");
    F("laneHours").textContent = `${dec} automatic declines save about ${Math.round(dec * MODEL.minutes_per_review / 60)} analyst hours on this file (25 minutes each).`;
    const rows = [];
    rows.push(["Incomes treated as annual (÷12)", scored.filter(r => r._fixed).length]);
    rows.push(["Blank incomes filled with job-type median", scored.filter(r => r._filled).length]);
    rows.push(["New-to-credit applicants (no score)", scored.filter(r => r.credit_score === null || r.credit_score === undefined || r.credit_score === "" || isNaN(r.credit_score)).length]);
    if (cols.includes("decision")) {
      const ad = scored.filter(r => r._lane === "decline"); const w = ad.filter(r => r.decision === "Approved").length;
      rows.push(["Auto-declines the bank actually approved", ad.length ? `${w} of ${ad.length} (${pct(w / ad.length)})` : "–"]);
    }
    if (cols.includes("gender")) {
      const g = k => { const s = scored.filter(r => r.gender === k); return s.length ? pct(s.filter(r => r._lane === "decline").length / s.length) : "–"; };
      rows.push(["Auto-decline rate · female", g("Female")]); rows.push(["Auto-decline rate · male", g("Male")]);
    }
    F("checkBody").innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td class="n">${b}</td></tr>`).join("");
    const top = [...scored].sort((a, b) => b._p - a._p).slice(0, 60);
    F("rowBody").innerHTML = top.map(r => `<tr><td class="num">${esc(r._id)}</td><td>${esc(r.employment_type)}</td><td class="n">${Math.round(r._inc).toLocaleString("en-IN")}</td><td class="n">${esc(r.credit_score ?? "–")}</td><td class="n">${pct(r._foir, 0)}</td><td class="n">${esc(r.delinquencies_24m)}</td><td class="n">${pct(r._p, 0)}</td><td><span class="tag ${r._lane}">${LANE[r._lane]}</span></td><td>${esc(r.decision ?? "–")}</td></tr>`).join("");
    F("rowNote").textContent = `Showing the ${top.length} applications with the highest decline confidence. The download includes all ${n}.`;
    paintBatchBanner();
    if (!F("v-report").hidden) renderReport();
  }

  function paintBatchBanner() {
    const b = F("batchBanner");
    if (!current || !current.saved) { b.hidden = true; return; }
    const s = current.saved, differs = +current.policy.threshold !== +policy.threshold || current.policy.route_ntc !== policy.route_ntc;
    let text = `Opened ${s.file_name || "a saved batch"}, saved ${fmtDate(s.created_at)}, scored with its saved policy (${describe(current.policy)}).`;
    if (s.model_version && s.model_version !== MODEL.version) text += ` It was saved with model ${s.model_version}; scores now use ${MODEL.version}.`;
    F("batchBannerText").textContent = text;
    F("batchRescore").hidden = !differs;
    b.hidden = false;
  }
  F("batchRescore").addEventListener("click", () => {
    if (!current) return;
    current.policy = {...policy};
    current.rows.forEach(r => { r._lane = M.laneOf(r._p, M.prepare(r).is_ntc, policy); });
    const saved = current.saved; current.saved = null; renderBatch();
    status("batchStatus", `Re-scored with your policy (${esc(describe(policy))}). The saved record of ${esc(saved.file_name || "this batch")} is unchanged.`, "");
  });

  function scoredCsv() {
    return Papa.unparse(current.rows.map(r => { const o = {}; for (const k in r) if (!k.startsWith("_")) o[k] = r[k];
      o.decline_confidence = +r._p.toFixed(4); o.foir = +r._foir.toFixed(4); o.lane = LANE[r._lane]; return o; }));
  }
  function saveFile(name, text, type) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], {type}));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  const fileBase = () => String(current && current.label || "batch").replace(/\.csv$/i, "").replace(/[^\w.-]+/g, "_").slice(0, 60) || "batch";
  function downloadScored() { if (current) saveFile(`${fileBase()}_scored.csv`, scoredCsv(), "text/csv"); }
  F("dlCsv").addEventListener("click", downloadScored);
  F("cpCsv").addEventListener("click", async e => {
    const b = e.currentTarget; try { await navigator.clipboard.writeText(scoredCsv()); b.textContent = "Copied"; } catch (err) { b.textContent = "Copy blocked here. Use Download"; }
    setTimeout(() => { b.textContent = "Copy CSV"; }, 2200);
  });

  function runSample() { status("batchStatus", ""); runBatch(SAMPLE_CSV, "Sample batch", policy, {isSample: true}); }
  F("loadSample").addEventListener("click", runSample);

  async function handleFile(f) {
    if (!f) return;
    status("batchStatus", "");
    if (f.size > MAX_FILE) { const e = F("batchErr"); e.hidden = false; e.textContent = "That file is larger than 10 MB. Split it into smaller files and upload each one."; return; }
    const text = await f.text();
    const summary = runBatch(text, f.name, policy, {});
    if (!summary) return;
    await saveBatch(f.name, text, summary);
  }
  async function saveBatch(name, text, s) {
    status("batchStatus", '<span class="spin" aria-hidden="true" style="display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;vertical-align:-1px"></span> Saving the file and its summary to your account…');
    let path = null;
    try {
      const {count, error: cErr} = await B.client.from("batches").select("id", {count: "exact", head: true});
      if (cErr) throw cErr;
      if (count >= LIMIT.batches) { status("batchStatus", `Scored but not saved: you have ${LIMIT.batches} saved batches. Delete one to save another. ${historyLink}`, "bad"); return; }
      const safe = name.replace(/\.csv$/i, "").replace(/[^\w.-]+/g, "_").slice(0, 80) || "intake";
      path = `${user.id}/${crypto.randomUUID()}-${safe}.csv`;
      const up = await B.client.storage.from(BUCKET).upload(path, new Blob([text], {type: "text/csv"}), {contentType: "text/csv", upsert: false});
      if (up.error) { path = null; throw up.error; }
      const row = {user_id: user.id, file_path: path, file_name: name.slice(0, 200), ...s, threshold: policy.threshold, route_ntc: policy.route_ntc, model_version: MODEL.version};
      const {error} = await B.client.from("batches").insert(row);
      if (error) throw error;
      path = null;
      hist.loaded = false;
      status("batchStatus", `Saved to History · ${count + 1} of ${LIMIT.batches} batch slots used. ${historyLink}`, "ok");
      refreshUsage();
    } catch (e) {
      if (path) await B.client.storage.from(BUCKET).remove([path]).catch(() => {});   // no orphan files
      const msg = dbError(e);
      status("batchStatus", "Scored but not saved: " + esc(msg) + (/Delete/.test(msg) ? " " + historyLink : ""), "bad");
    }
  }
  F("file").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; handleFile(f); });
  const drop = F("drop");
  ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });

  // ---------- report (Clarity-style: visual summary, then the numbered analyst report) ----------
  let reportModel = null;
  function renderReport() {
    if (!current) { F("reportBody").innerHTML = '<div class="empty"><b>No batch yet</b>Upload an intake file on the Batch tab.</div>'; reportModel = null; return; }
    reportModel = window.TriageReport.build(current, M, MODEL, {author: F("acctName").textContent || (user && user.email) || ""});
    F("reportBody").innerHTML = window.TriageReport.html(reportModel);
    F("repSource").textContent = current.isSample ? "the sample batch" : current.label + (current.saved ? " (saved)" : "");
  }
  F("repMd").addEventListener("click", () => { if (reportModel) { saveFile(`${fileBase()}_report.md`, window.TriageReport.markdown(reportModel), "text/markdown"); toast("Report exported as Markdown."); } });
  F("repHtml").addEventListener("click", async () => {
    if (!reportModel) return;
    let styles = "";
    try { styles = await (await fetch("/css/triage.css")).text(); } catch (e) { status("repStatus", "Couldn't load the styles for the HTML export. Try again.", "bad"); return; }
    const doc = `<!doctype html>\n<html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Triage report · ${esc(reportModel.file)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>${styles}\nbody{padding:32px 0}</style></head>
<body><main class="wrap"><div class="report">${window.TriageReport.html(reportModel)}</div></main></body></html>`;
    saveFile(`${fileBase()}_report.html`, doc, "text/html");
    toast("Report exported as HTML.");
  });
  F("repPrint").addEventListener("click", () => {
    if (!reportModel) return;
    document.body.classList.add("print-report");
    window.print();
  });
  window.addEventListener("afterprint", () => document.body.classList.remove("print-report"));
  F("repCsv").addEventListener("click", downloadScored);

  // ---------- history ----------
  async function fetchHistory() {
    const [s, b] = await Promise.all([
      B.client.from("scorings").select("id,inputs,probability,lane,threshold,model_version,note,created_at").order("created_at", {ascending: false}).limit(LIMIT.scorings),
      B.client.from("batches").select("*").order("created_at", {ascending: false}).limit(LIMIT.batches),
    ]);
    if (s.error) throw s.error;
    if (b.error) throw b.error;
    hist.scorings = s.data || []; hist.batches = b.data || []; hist.loaded = true;
  }
  async function loadHistory(force) {
    if (hist.loaded && !force) { renderHistory(); return; }
    if (!hist.loading) {
      status("hStatus", "Loading your history…");
      hist.loading = fetchHistory().then(() => status("hStatus", ""), e => status("hStatus", esc(dbError(e)), "bad")).finally(() => { hist.loading = null; });
    }
    await hist.loading;
    renderHistory();
  }
  async function refreshUsage() {
    try { await fetchHistory(); } catch (e) { return; }
    paintUsage();
    if (!F("v-history").hidden) renderHistory();
  }
  function paintUsage() {
    if (!hist.loaded) return;
    const s = hist.scorings.length, b = hist.batches.length;
    const meter = (n, cap) => `<span class="meter" aria-hidden="true"><i style="width:${Math.min(100, n / cap * 100)}%"></i></span>`;
    F("usage").innerHTML = `<span>Scorings <b>${s} / ${LIMIT.scorings}</b>${meter(s, LIMIT.scorings)}</span><span>Batches <b>${b} / ${LIMIT.batches}</b>${meter(b, LIMIT.batches)}</span>`;
    F("scoreUsage").textContent = `${s} of ${LIMIT.scorings} saved`;
  }

  function itemsFor() {
    const q = hist.q.trim().toLowerCase();
    const items = [
      ...hist.scorings.map(s => ({kind: "scoring", at: s.created_at, rec: s,
        text: [s.note, LANE[s.lane], s.inputs && s.inputs.employment_type, s.inputs && s.inputs.loan_purpose, Math.round(s.probability * 100) + "%", fmtDate(s.created_at), "scoring"].join(" ")})),
      ...hist.batches.map(b => ({kind: "batch", at: b.created_at, rec: b,
        text: [b.file_name, "batch", b.row_count + " applications", fmtDate(b.created_at), Object.keys(b.lane_counts || {}).map(k => LANE[k]).join(" ")].join(" ")})),
    ].sort((a, b) => b.at.localeCompare(a.at));
    return items.filter(i => (hist.filter === "all" || hist.filter === i.kind) && (!q || i.text.toLowerCase().includes(q)));
  }

  function renderHistory() {
    paintUsage();
    const list = F("hList"), items = itemsFor();
    if (!hist.scorings.length && !hist.batches.length) {
      list.innerHTML = `<li class="empty"><b>Nothing saved yet</b>Score an application and press “Save to history”, or upload an intake file on the Batch tab.</li>`;
      return;
    }
    if (!items.length) { list.innerHTML = `<li class="empty"><b>No matches</b>Nothing in your history matches “${esc(hist.q)}”.</li>`; return; }
    list.innerHTML = items.map(i => i.kind === "scoring" ? scoringItem(i.rec) : batchItem(i.rec)).join("");
  }
  function scoringItem(s) {
    const inp = s.inputs || {}, old = s.model_version !== MODEL.version;
    const what = [inp.employment_type, inp.loan_amount ? fmtINR(inp.loan_amount) + " " + (inp.loan_purpose || "") : null].filter(Boolean).join(" · ");
    return `<li class="hitem" data-kind="scoring" data-id="${s.id}">
      <div><h3><span class="tag ${s.lane}">${LANE[s.lane]}</span> <span class="num">${Math.round(s.probability * 100)}%</span> decline confidence</h3>
        <div class="hmeta"><span>${esc(what)}</span><span>${fmtDate(s.created_at)}</span>${s.threshold ? `<span>threshold <span class="num">${(+s.threshold).toFixed(2)}</span></span>` : ""}${old ? `<span class="flag-warn">model ${esc(s.model_version)}</span>` : ""}</div>
        ${s.note ? `<div class="hnote">${esc(s.note)}</div>` : ""}</div>
      ${actions(s.id, "scoring", '<button class="btn" type="button" data-act="open">Re-open</button>')}</li>`;
  }
  // A pending delete confirmation is part of the history state, so a background refresh re-renders it instead of losing it
  function actions(id, kind, extra) {
    if (hist.confirming === id) return `<div class="hact"><span style="font-size:13px;color:var(--ink);align-self:center">Delete this ${kind}?</span><button class="btn danger solid" type="button" data-act="confirm">Yes, delete</button><button class="btn" type="button" data-act="cancel">Cancel</button></div>`;
    return `<div class="hact">${extra}<button class="btn danger" type="button" data-act="delete">Delete</button></div>`;
  }
  function batchItem(b) {
    const lc = b.lane_counts || {};
    return `<li class="hitem" data-kind="batch" data-id="${b.id}">
      <div><h3><span class="tag neutral">Batch</span> ${esc(b.file_name || "Intake file")}</h3>
        <div class="hmeta"><span><span class="num">${b.row_count}</span> applications</span><span><span class="num">${lc.decline ?? 0}</span> auto-declined · <span class="num">${lc.review ?? 0}</span> review · <span class="num">${lc.human ?? 0}</span> new to credit</span>
        ${b.wrong_decline_rate !== null && b.wrong_decline_rate !== undefined ? `<span><span class="num">${pct(b.wrong_decline_rate)}</span> wrongly declined</span>` : ""}
        <span>threshold <span class="num">${(+b.threshold).toFixed(2)}</span></span><span>${fmtDate(b.created_at)}</span></div></div>
      ${actions(b.id, "batch", '<button class="btn" type="button" data-act="open">Re-open</button><button class="btn" type="button" data-act="report">Report</button><button class="btn" type="button" data-act="download">Download scored CSV</button>')}</li>`;
  }

  F("hSearch").addEventListener("input", e => { hist.q = e.target.value; renderHistory(); });
  document.querySelectorAll("[data-filter]").forEach(b => b.addEventListener("click", () => {
    hist.filter = b.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach(x => x.setAttribute("aria-pressed", x === b));
    renderHistory();
  }));

  F("hList").addEventListener("click", async e => {
    const btn = e.target.closest("button[data-act]"); if (!btn) return;
    const li = btn.closest(".hitem"), kind = li.dataset.kind, id = li.dataset.id;
    const rec = (kind === "scoring" ? hist.scorings : hist.batches).find(r => r.id === id);
    if (!rec) return;
    const act = btn.dataset.act;
    if (act === "delete" || act === "cancel") {   // inline confirmation instead of confirm()
      hist.confirming = act === "delete" ? id : null;
      renderHistory();
      const again = F("hList").querySelector(`[data-id="${id}"] [data-act="${act === "delete" ? "confirm" : "delete"}"]`);
      if (again) again.focus();
      return;
    }
    if (act === "confirm") return deleteItem(kind, rec, btn, li);
    if (act === "open") return kind === "scoring" ? openScoring(rec) : openBatch(rec, btn);
    if (act === "download") { const ok = await openBatch(rec, btn, {stay: true}); if (ok) downloadScored(); }
    if (act === "report") { const ok = await openBatch(rec, btn, {stay: true}); if (ok) { show("report"); F("main").focus({preventScroll: true}); } }
  });

  async function deleteItem(kind, rec, btn, li) {
    busy(btn, true, "Deleting…");
    try {
      if (kind === "batch" && rec.file_path) await B.client.storage.from(BUCKET).remove([rec.file_path]);
      const {error} = await B.client.from(kind === "scoring" ? "scorings" : "batches").delete().eq("id", rec.id);
      if (error) throw error;
      if (kind === "scoring") hist.scorings = hist.scorings.filter(r => r.id !== rec.id); else hist.batches = hist.batches.filter(r => r.id !== rec.id);
      hist.confirming = null;
      if (current && current.saved && current.saved.id === rec.id) { current.saved = null; paintBatchBanner(); }
      const next = li.nextElementSibling || li.previousElementSibling;
      renderHistory();
      toast(kind === "scoring" ? "Scoring deleted. A slot is free." : "Batch and its file deleted. A slot is free.");
      const target = next && F("hList").querySelector(`[data-id="${next.dataset.id}"] button`);
      (target || F("hSearch")).focus();
    } catch (e) { busy(btn, false); status("hStatus", esc(dbError(e)), "bad"); }
  }

  function openScoring(s) {
    const inp = s.inputs || {};
    fillForm({...inp, city_tier: String(inp.city_tier ?? 2), tenure_months: String(inp.tenure_months ?? 36), ntc: !!inp.ntc});
    const res = renderScore();
    let text = `Re-opened a scoring saved ${fmtDate(s.created_at)}: ${LANE[s.lane]} at ${Math.round(s.probability * 100)}%` + (s.threshold ? `, threshold ${(+s.threshold).toFixed(2)}.` : ".");
    if (res.lane !== s.lane) text += ` With your current policy it lands in ${LANE[res.lane]}.`;
    if (s.model_version !== MODEL.version) text += ` Saved with model ${s.model_version}.`;
    if (s.note) text += ` Note: “${s.note}”`;
    F("openBannerText").textContent = text; F("openBanner").hidden = false;
    show("score"); F("openBanner").scrollIntoView({block: "nearest"});
    F("openBannerClose").focus();
  }

  async function openBatch(b, btn, opts) {
    if (btn) busy(btn, true, "Opening…");
    try {
      const {data, error} = await B.client.storage.from(BUCKET).download(b.file_path);
      if (error) throw error;
      const text = await data.text();
      const ok = runBatch(text, b.file_name || "Saved batch", {threshold: +b.threshold, route_ntc: b.route_ntc}, {saved: b});
      status("batchStatus", "");
      if (!(opts && opts.stay)) { show("batch"); F("batchBanner").scrollIntoView({block: "nearest"}); }
      return !!ok;
    } catch (e) {
      const msg = /not.?found|Object not found/i.test(e.message || "") ? "The stored file for this batch is missing. Delete the record and upload the file again." : dbError(e);
      status("hStatus", esc(msg), "bad");
      return false;
    } finally { if (btn) busy(btn, false); }
  }

  // ---------- model view ----------
  function renderModel() {
    const m = MODEL.metrics;
    F("facts").innerHTML = [["Accuracy (0.5)", pct(m.accuracy)], ["ROC-AUC", m.roc_auc.toFixed(3)], ["Precision · declines", pct(m.precision_declined)], ["Recall · declines", pct(m.recall_declined)]]
      .map(([a, b]) => `<div class="kpi"><span>${a}</span><b>${b}</b></div>`).join("");
    const all = [...MODEL.numeric.map(f => ({label: NUM_LABEL[f.name], c: f.coef})),
      ...MODEL.categorical.flatMap(f => Object.entries(f.levels).map(([k, c]) => ({label: (f.name === "employment_type" ? "Job: " : "Purpose: ") + k, c})))]
      .sort((a, b) => Math.abs(b.c) - Math.abs(a.c)).slice(0, 10);
    F("coefList").innerHTML = all.map(c => { const pos = c.c > 0, w = Math.abs(c.c) / 1.4 * 50;
      return `<div class="drv"><div class="lbl"><b>${esc(c.label)}</b><span>${c.c > 0 ? "+" : ""}${c.c.toFixed(2)}</span></div><div class="dbar"><i style="${pos ? "left:50%" : "right:50%"};width:${w}%;background:var(${pos ? "--series-2" : "--accent"})"></i></div></div>`; }).join("");
    const c = m.confusion;
    F("cmTable").innerHTML = `<thead><tr><th></th><th class="n">Model: approve lane</th><th class="n">Model: decline</th></tr></thead><tbody>
      <tr><td>Bank approved</td><td class="n">${c.tn}</td><td class="n" style="color:var(--decline);font-weight:600">${c.fp}</td></tr>
      <tr><td>Bank declined</td><td class="n">${c.fn}</td><td class="n">${c.tp}</td></tr></tbody>`;
    F("footVer").textContent = MODEL.version;
  }

  // ---------- account menu ----------
  function openMenu() { F("acctMenu").hidden = false; F("acctBtn").setAttribute("aria-expanded", "true"); F("acctItems").querySelector(".mi").focus(); }
  function closeMenu(focusBtn) {
    if (F("acctMenu").hidden) return;
    F("acctMenu").hidden = true; F("acctBtn").setAttribute("aria-expanded", "false");
    F("delPanel").hidden = true; F("acctItems").hidden = false; F("delType").value = ""; F("delGo").disabled = true; status("delStatus", "", "bad");
    if (focusBtn) F("acctBtn").focus();
  }
  F("acctBtn").addEventListener("click", () => F("acctMenu").hidden ? openMenu() : closeMenu());
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !F("acctMenu").hidden) closeMenu(true); });
  document.addEventListener("click", e => { if (!e.target.closest(".acct")) closeMenu(); });
  F("acctMenu").addEventListener("keydown", e => {
    if (!["ArrowDown", "ArrowUp"].includes(e.key) || F("acctItems").hidden) return;
    const items = [...F("acctItems").querySelectorAll(".mi")], i = items.indexOf(document.activeElement);
    e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
  });

  function paintAccount(profile) {
    const md = user.user_metadata || {};
    const name = (profile && profile.display_name) || md.display_name || md.full_name || md.name || user.email.split("@")[0];
    F("acctName").textContent = name; F("acctEmail").textContent = user.email;
    F("acctBtn").textContent = (name[0] || "?").toUpperCase();
    F("acctBtn").setAttribute("aria-label", `Account menu for ${user.email}`);
  }

  F("signOut").addEventListener("click", async () => {
    leaving = true;
    try { await B.client.auth.signOut(); } catch (e) {}
    location.replace("/login");
  });

  F("delOpen").addEventListener("click", async () => {
    F("acctItems").hidden = true; F("delPanel").hidden = false; F("delType").focus();
    try {
      const [s, b] = await Promise.all([B.client.from("scorings").select("id", {count: "exact", head: true}), B.client.from("batches").select("id", {count: "exact", head: true})]);
      if (!s.error && !b.error) F("delCounts").textContent = `${s.count} saved scoring${s.count === 1 ? "" : "s"}, ${b.count} batch${b.count === 1 ? "" : "es"}`;
    } catch (e) {}
  });
  F("delCancel").addEventListener("click", () => { F("delPanel").hidden = true; F("acctItems").hidden = false; F("delType").value = ""; F("delGo").disabled = true; F("delOpen").focus(); });
  F("delType").addEventListener("input", e => { F("delGo").disabled = e.target.value.trim() !== "DELETE"; });
  F("delGo").addEventListener("click", async () => {
    const btn = F("delGo"); busy(btn, true, "Deleting…"); status("delStatus", "", "bad");
    try {
      // Files first: Supabase only lets the Storage API remove them. Then the database row cascade.
      const {data: files, error: lErr} = await B.client.storage.from(BUCKET).list(user.id, {limit: 1000});
      if (lErr) throw lErr;
      if (files && files.length) { const {error} = await B.client.storage.from(BUCKET).remove(files.map(f => `${user.id}/${f.name}`)); if (error) throw error; }
      const {error} = await B.client.rpc("delete_account");
      if (error) throw error;
      leaving = true;
      await B.client.auth.signOut({scope: "local"}).catch(() => {});
      location.replace("/?account=deleted");
    } catch (e) { busy(btn, false); status("delStatus", esc(dbError(e)), "bad"); }
  });

  // ---------- data loading ----------
  async function ensureProfile() {
    const {data, error} = await B.client.from("profiles").select("id,display_name").eq("id", user.id).maybeSingle();
    if (error) throw error;
    if (data) return data;
    const md = user.user_metadata || {};
    const row = {id: user.id, display_name: (md.display_name || md.full_name || md.name || "").slice(0, 120)};
    const ins = await B.client.from("profiles").insert(row);
    if (ins.error) throw ins.error;
    return row;
  }
  async function loadPolicy() {
    const {data, error} = await B.client.from("policies").select("threshold,route_ntc").eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    if (data) policy = {threshold: +(+data.threshold).toFixed(2), route_ntc: !!data.route_ntc};
  }

  // Sticky offsets follow the real header height (it grows when the tabs wrap onto their own row)
  const hdr = document.querySelector("header");
  const setHdr = () => document.documentElement.style.setProperty("--hdr-h", hdr.offsetHeight + "px");
  if (window.ResizeObserver) new ResizeObserver(setHdr).observe(hdr); else setHdr();

  document.addEventListener("themechange", () => { renderScore(); if (!F("v-threshold").hidden) drawThreshold(); });

  // ---------- boot ----------
  async function boot() {
    if (!B.client) { location.replace("/login?next=/app"); return; }
    const session = await B.getSession();
    if (!session) { location.replace("/login?next=" + encodeURIComponent("/app" + (views.includes(location.hash.slice(1)) ? location.hash : ""))); return; }
    user = session.user;
    B.client.auth.onAuthStateChange((evt, s) => {
      if (leaving) return;
      if (evt === "SIGNED_OUT" || !s) location.replace("/login");
      else user = s.user;
    });
    paintAccount();
    renderModel(); renderScore(); runSample();
    let start = "score"; try { start = localStorage.getItem("triage-view") || "score"; } catch (e) {}
    const h = location.hash.replace("#", ""); if (views.includes(h)) start = h;
    show(views.includes(start) ? start : "score");
    document.documentElement.classList.remove("auth-pending");
    try {
      const [profile] = await Promise.all([ensureProfile(), loadPolicy()]);
      paintAccount(profile);
      applyPolicy();
      refreshUsage();
    } catch (e) { dbError(e); applyPolicy(); }
  }
  boot();
})();
