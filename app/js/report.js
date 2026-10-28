/* Intake report: a visual one-page summary plus a numbered analyst report for one scored batch,
   in the style of Clarity's report. Built only from the batch rows, its policy and model.json,
   so a saved batch re-opened from History produces the same report. */
(function (root) {
  "use strict";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const pct = (v, d = 1) => (v * 100).toFixed(d) + "%";
  const int = v => Math.round(v).toLocaleString("en-IN");
  const LANE = {decline: "Auto-decline", review: "Analyst review", human: "Analyst only · new to credit"};
  const LANE_COLOR = {decline: "--decline", review: "--accent", human: "--human"};

  function build(batch, M, MODEL, extra) {
    const rows = batch.rows, n = rows.length, pol = batch.policy, t = +pol.threshold;
    const lanes = {decline: 0, review: 0, human: 0};
    const known = {}; MODEL.categorical.forEach(f => { known[f.name] = new Set(Object.keys(f.levels)); });
    const unknown = {employment_type: 0, loan_purpose: 0};
    let ntc = 0, fixed = 0, filled = 0;
    for (const r of rows) {
      lanes[r._lane]++;
      if (r._fixed) fixed++;
      if (r._filled) filled++;
      if (M.prepare(r).is_ntc) ntc++;
      for (const k in unknown) if (!known[k].has(String(r[k]))) unknown[k]++;
    }
    const auto = rows.filter(r => r._lane === "decline");
    const hours = lanes.decline * MODEL.minutes_per_review / 60;

    let outcome = null;
    if (batch.cols.includes("decision")) {
      const wrong = auto.filter(r => r.decision === "Approved").length;
      const bankDeclined = rows.filter(r => r.decision === "Declined").length;
      outcome = {wrong, wrongRate: auto.length ? wrong / auto.length : 0, bankDeclined,
        caught: auto.length - wrong, caughtShare: bankDeclined ? (auto.length - wrong) / bankDeclined : 0,
        bankApproved: rows.filter(r => r.decision === "Approved").length};
    }
    let fairness = null;
    if (batch.cols.includes("gender")) {
      const g = k => { const s = rows.filter(r => r.gender === k); return {n: s.length, rate: s.length ? s.filter(r => r._lane === "decline").length / s.length : null}; };
      fairness = {female: g("Female"), male: g("Male")};
    }
    const groups = {};
    for (const r of rows) {
      const k = String(r.employment_type ?? "–");
      const g = groups[k] || (groups[k] = {n: 0, auto: 0, sumP: 0});
      g.n++; g.sumP += r._p; if (r._lane === "decline") g.auto++;
    }
    const byEmployment = Object.entries(groups).map(([name, g]) => ({name, n: g.n, auto: g.auto, rate: g.auto / g.n, meanP: g.sumP / g.n}))
      .sort((a, b) => b.rate - a.rate || b.n - a.n);
    const bins = Array.from({length: 10}, (_, i) => ({lo: i / 10, hi: (i + 1) / 10, n: 0}));
    for (const r of rows) bins[Math.min(9, Math.floor(r._p * 10))].n++;

    const m = {file: batch.label, n, policy: {threshold: t, route_ntc: !!pol.route_ntc}, lanes, ntc, fixed, filled, unknown, hours, outcome, fairness,
      byEmployment, bins, top: [...auto].sort((a, b) => b._p - a._p).slice(0, 10), test: M.stats(t),
      model: {version: MODEL.version, auc: MODEL.metrics.roc_auc, minutes: MODEL.minutes_per_review},
      savedAt: batch.saved ? batch.saved.created_at : null, isSample: !!batch.isSample,
      author: extra && extra.author || "", generated: new Date()};
    m.findings = findings(m);
    return m;
  }

  function findings(m) {
    const f = [], t = m.policy.threshold.toFixed(2);
    f.push({tag: "AUTOMATION", tx: `${int(m.lanes.decline)} of ${int(m.n)} applications (${pct(m.lanes.decline / m.n)}) can be declined automatically, freeing about ${int(m.hours)} analyst hours.`,
      ev: `threshold ${t} · ${m.model.minutes} minutes per review`});
    if (m.outcome) {
      const ok = m.outcome.wrongRate <= 0.05;
      f.push({tag: ok ? "WITHIN LIMIT" : "RISK", tx: `${m.outcome.wrong} of ${m.lanes.decline} automatic declines (${pct(m.outcome.wrongRate)}) were applicants the bank approved, ${ok ? "inside" : "above"} the 5% limit.`,
        ev: "compared with the file's decision column"});
    } else {
      f.push({tag: "EXPECTED RISK", tx: `This file has no decision column. On the 2,400 held-out applications this threshold wrongly declines ${pct(m.test.wrongRate)} of automatic declines.`,
        ev: `test set at ${t}`});
    }
    f.push({tag: "NEW TO CREDIT", tx: `${int(m.ntc)} applicants have no bureau score. They are never auto-declined and went to the ${m.policy.route_ntc ? "analyst-only lane" : "normal analyst queue"}.`,
      ev: "the model is right only 56.7% of the time for them"});
    const seg = m.byEmployment.filter(g => g.n >= 10)[0];
    if (seg && seg.auto) f.push({tag: "SEGMENT", tx: `${seg.name} applicants are auto-declined most often: ${seg.auto} of ${seg.n} (${pct(seg.rate)}).`, ev: "employment types with at least 10 applications"});
    if (m.fairness && m.fairness.female.rate !== null && m.fairness.male.rate !== null) {
      const gap = (m.fairness.female.rate - m.fairness.male.rate) * 100;
      f.push({tag: "FAIRNESS", tx: `Auto-decline rate is ${pct(m.fairness.female.rate)} for female and ${pct(m.fairness.male.rate)} for male applicants (${gap >= 0 ? "+" : ""}${gap.toFixed(1)} pts).`,
        ev: "gender is not a model input; income and job type can stand in for it"});
    }
    const unk = m.unknown.employment_type + m.unknown.loan_purpose;
    if (m.fixed || m.filled || unk) f.push({tag: "DATA", tx: `${m.fixed} incomes treated as annual, ${m.filled} blank incomes filled with the job-type median${unk ? `, ${unk} values the model has never seen (scored as neutral)` : ""}.`, ev: "cleaning rules from the team notebook"});
    return f;
  }

  // ---------- charts (inline SVG, colours from the page's theme tokens) ----------
  function laneChart(m) {
    const W = 640, row = 46, H = row * 3 + 10, left = 210, barW = W - left - 70, max = Math.max(1, ...Object.values(m.lanes));
    const bars = Object.keys(LANE).map((k, i) => {
      const y = 8 + i * row, w = Math.max(2, m.lanes[k] / max * barW);
      return `<text x="0" y="${y + 19}" font-size="13" style="fill:var(--ink)">${LANE[k]}</text>` +
        `<rect x="${left}" y="${y + 4}" width="${w}" height="22" rx="4" style="fill:var(${LANE_COLOR[k]})"/>` +
        `<text x="${left + w + 8}" y="${y + 20}" font-size="12.5" font-family="IBM Plex Mono, monospace" style="fill:var(--ink)">${int(m.lanes[k])} · ${pct(m.lanes[k] / m.n, 0)}</text>`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Applications per lane: ${Object.keys(LANE).map(k => `${LANE[k]} ${m.lanes[k]}`).join(", ")}">${bars}</svg>`;
  }
  function histChart(m) {
    const W = 640, H = 220, L = 36, R = 8, T = 10, B = 34, max = Math.max(1, ...m.bins.map(b => b.n));
    const bw = (W - L - R) / 10, ys = v => T + (1 - v / max) * (H - T - B);
    let g = "";
    for (const v of [0, Math.round(max / 2), max]) g += `<line x1="${L}" x2="${W - R}" y1="${ys(v)}" y2="${ys(v)}" style="stroke:var(--line)"/><text x="${L - 6}" y="${ys(v) + 4}" font-size="11" text-anchor="end" font-family="IBM Plex Mono, monospace" style="fill:var(--muted)">${v}</text>`;
    m.bins.forEach((b, i) => {
      const x = L + i * bw + 3, h = (H - T - B) - (ys(b.n) - T);
      g += `<rect x="${x}" y="${ys(b.n)}" width="${bw - 6}" height="${Math.max(0, h)}" rx="3" style="fill:var(${b.lo >= m.policy.threshold - 1e-9 ? "--decline" : b.hi > m.policy.threshold ? "--series-2" : "--accent"})"/>`;
      g += `<text x="${x + (bw - 6) / 2}" y="${H - B + 16}" font-size="10.5" text-anchor="middle" font-family="IBM Plex Mono, monospace" style="fill:var(--muted)">${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}</text>`;
    });
    const tx = L + m.policy.threshold * (W - L - R);
    g += `<line x1="${tx}" x2="${tx}" y1="${T}" y2="${H - B}" stroke-dasharray="5 4" stroke-width="1.5" style="stroke:var(--ink)"/><text x="${tx - 6}" y="${T + 12}" font-size="11" text-anchor="end" style="fill:var(--ink)">threshold ${m.policy.threshold.toFixed(2)}</text>`;
    g += `<text x="${(L + W - R) / 2}" y="${H - 2}" font-size="11" text-anchor="middle" style="fill:var(--muted)">Decline confidence (%)</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Histogram of decline confidence across the file, with the threshold at ${m.policy.threshold.toFixed(2)}">${g}</svg>`;
  }

  function policyLine(m) { return `threshold ${m.policy.threshold.toFixed(2)} · new to credit → ${m.policy.route_ntc ? "analyst only" : "analyst queue"}`; }
  function sourceLine(m) {
    const when = m.savedAt ? `saved ${new Date(m.savedAt).toLocaleString("en-IN", {dateStyle: "medium", timeStyle: "short"})}` : "not saved";
    return `${esc(m.file)} · ${int(m.n)} applications · ${when}`;
  }

  // ---------- HTML ----------
  function html(m) {
    const o = m.outcome, wrongKpi = o ? {v: pct(o.wrongRate), l: "auto-declines the bank approved"} : {v: pct(m.test.wrongRate), l: "expected wrong declines (test set)"};
    const ringColor = (o ? o.wrongRate : m.test.wrongRate) <= 0.05 ? "--ok" : "--decline";
    const share = m.lanes.decline / m.n;
    const laneRows = Object.keys(LANE).map(k => `<tr><td><span class="tag ${k}">${LANE[k]}</span></td><td class="n">${int(m.lanes[k])}</td><td class="n">${pct(m.lanes[k] / m.n)}</td><td class="n">${k === "decline" ? int(m.hours) : "–"}</td></tr>`).join("");
    const empRows = m.byEmployment.map(g => `<tr><td>${esc(g.name)}</td><td class="n">${int(g.n)}</td><td class="n">${int(g.auto)}</td><td class="n">${pct(g.rate)}</td><td class="n">${pct(g.meanP, 0)}</td></tr>`).join("");
    const topRows = m.top.map(r => `<tr><td class="num">${esc(r._id)}</td><td>${esc(r.employment_type)}</td><td class="n">${int(r._inc)}</td><td class="n">${esc(r.credit_score ?? "–")}</td><td class="n">${pct(r._foir, 0)}</td><td class="n">${esc(r.delinquencies_24m)}</td><td class="n">${pct(r._p, 1)}</td>${o ? `<td>${esc(r.decision ?? "–")}</td>` : ""}</tr>`).join("");
    const unk = m.unknown.employment_type + m.unknown.loan_purpose;
    return `<section class="rp-visual" aria-label="Visual summary">
  <div class="rp-hero">
    <div class="rp-card">
      <div class="rp-title">Intake triage: visual summary</div>
      <div class="rp-sub">${sourceLine(m)} · ${policyLine(m)}</div>
      <div class="rp-kpis">
        <div class="rp-kpi"><b>${int(m.n)}</b><span>applications scored</span></div>
        <div class="rp-kpi"><b>${int(m.lanes.decline)}</b><span>auto-declined (${pct(share)})</span></div>
        <div class="rp-kpi"><b>~${int(m.hours)}</b><span>analyst hours freed</span></div>
        <div class="rp-kpi"><b>${int(m.ntc)}</b><span>new to credit</span></div>
      </div>
    </div>
    <div class="rp-card">
      <h3>The 5% rule</h3><p>Share of automatic declines that were people the bank approved.</p>
      <div class="rp-ring-row"><div class="rp-ring" style="background:conic-gradient(var(${ringColor}) ${Math.min(1, (o ? o.wrongRate : m.test.wrongRate) / 0.1) * 360}deg, var(--surface-2) 0deg)"><b>${wrongKpi.v}</b></div>
        <div class="rp-ring-copy"><strong>${(o ? o.wrongRate : m.test.wrongRate) <= 0.05 ? "Inside the 5% limit" : "Above the 5% limit"}</strong><br>${wrongKpi.l}.<br>Ring fills at 10%; the limit is half way.</div></div>
    </div>
  </div>
  <div class="rp-hero">
    <div class="rp-card"><h3>Applications per lane</h3><p>The model never approves. Only the first lane skips an analyst.</p>${laneChart(m)}</div>
    <div class="rp-card"><h3>Decline confidence across the file</h3><p>Bars at or right of the dashed line are auto-declined if the applicant has a bureau score.</p>${histChart(m)}</div>
  </div>
  <div class="rp-card"><h3>Key findings</h3><p>Generated from this file's scores and the saved policy.</p>
    <div class="rp-findings">${m.findings.map(x => `<div class="rp-finding"><span class="rp-tag">${x.tag}</span><div class="tx">${esc(x.tx)}</div><div class="ev">${esc(x.ev)}</div></div>`).join("")}</div>
  </div>
</section>

<article class="rp-doc">
  <h1>Intake triage report</h1>
  <div class="meta">${sourceLine(m)} · model ${esc(m.model.version)} · generated ${m.generated.toLocaleString("en-IN", {dateStyle: "medium", timeStyle: "short"})}${m.author ? ` · prepared by ${esc(m.author)}` : ""}</div>

  <h2>Executive summary</h2>
  <p>Triage scored <b>${int(m.n)}</b> applications from <b>${esc(m.file)}</b> with the policy <b>${policyLine(m)}</b>. <b>${int(m.lanes.decline)}</b> (${pct(share)}) are clear declines that can skip manual review, freeing about <b>${int(m.hours)} analyst hours</b> at ${m.model.minutes} minutes each. The other <b>${int(m.lanes.review + m.lanes.human)}</b> go to a credit analyst, including <b>${int(m.ntc)}</b> applicants with no credit history. ${o ? `Against the bank's own decisions, <b>${pct(o.wrongRate)}</b> of automatic declines were people it approved, ${o.wrongRate <= 0.05 ? "inside" : "above"} the 5% limit.` : `The file has no decision column; on held-out test data this threshold wrongly declines <b>${pct(m.test.wrongRate)}</b> of automatic declines.`}</p>

  <h2>1. Policy applied</h2>
  <table><tr><th>Setting</th><th>Value</th></tr>
    <tr><td>Auto-decline threshold</td><td>${m.policy.threshold.toFixed(2)} decline confidence, and only with a bureau score</td></tr>
    <tr><td>New-to-credit applicants</td><td>${m.policy.route_ntc ? "Analyst-only lane" : "Normal analyst queue"}</td></tr>
    <tr><td>Model</td><td>${esc(m.model.version)} · logistic regression · ROC-AUC ${m.model.auc.toFixed(3)}</td></tr>
    <tr><td>Expected at this threshold (test set)</td><td>${pct(m.test.share)} auto-declined · ${pct(m.test.wrongRate)} wrongly declined · ${pct(m.test.caught)} of declines caught</td></tr></table>

  <h2>2. Data checks and cleaning</h2>
  <table><tr><th>Check</th><th>Rows</th></tr>
    <tr><td>Incomes above ₹6,00,000 treated as annual (÷12)</td><td class="n">${int(m.fixed)}</td></tr>
    <tr><td>Blank incomes filled with the employment-type median</td><td class="n">${int(m.filled)}</td></tr>
    <tr><td>No credit score (new to credit, median used only inside the model)</td><td class="n">${int(m.ntc)}</td></tr>
    <tr><td>Employment types the model has not seen (scored as neutral)</td><td class="n">${int(m.unknown.employment_type)}</td></tr>
    <tr><td>Loan purposes the model has not seen (scored as neutral)</td><td class="n">${int(m.unknown.loan_purpose)}</td></tr></table>
  ${unk ? `<p class="rp-warn">${int(unk)} values were not in the training data. Check the spelling against the bank's categories before relying on those scores.</p>` : ""}

  <h2>3. Lane outcomes</h2>
  <table><tr><th>Lane</th><th class="n">Applications</th><th class="n">Share</th><th class="n">Hours freed</th></tr>${laneRows}</table>

  <h2>4. Check against the bank's decisions</h2>
  ${o ? `<table><tr><th>Measure</th><th class="n">Value</th></tr>
    <tr><td>Automatic declines the bank also declined</td><td class="n">${int(o.caught)}</td></tr>
    <tr><td>Automatic declines the bank approved (wrong declines)</td><td class="n">${int(o.wrong)} (${pct(o.wrongRate)})</td></tr>
    <tr><td>Bank declines caught automatically</td><td class="n">${int(o.caught)} of ${int(o.bankDeclined)} (${pct(o.caughtShare)})</td></tr>
    <tr><td>Bank approvals in the file</td><td class="n">${int(o.bankApproved)}</td></tr></table>`
    : `<p>The file has no <code>decision</code> column, so automatic declines cannot be checked against the bank's own decisions. Expected wrong-decline rate from the test set: ${pct(m.test.wrongRate)}.</p>`}

  <h2>5. Fairness monitor</h2>
  ${m.fairness ? `<table><tr><th>Group</th><th class="n">Applications</th><th class="n">Auto-decline rate</th></tr>
    <tr><td>Female applicants</td><td class="n">${int(m.fairness.female.n)}</td><td class="n">${m.fairness.female.rate === null ? "–" : pct(m.fairness.female.rate)}</td></tr>
    <tr><td>Male applicants</td><td class="n">${int(m.fairness.male.n)}</td><td class="n">${m.fairness.male.rate === null ? "–" : pct(m.fairness.male.rate)}</td></tr></table>
    <p>Gender is not a model input, but income and job type can stand in for it. Report this table every month.</p>`
    : `<p>The file has no <code>gender</code> column, so auto-decline rates by gender cannot be reported for it.</p>`}

  <h2>6. By employment type</h2>
  <table><tr><th>Employment type</th><th class="n">Applications</th><th class="n">Auto-declined</th><th class="n">Rate</th><th class="n">Mean confidence</th></tr>${empRows}</table>

  <h2>7. Highest-confidence automatic declines</h2>
  ${m.top.length ? `<div class="tscroll"><table><tr><th>Application</th><th>Employment</th><th class="n">Income ₹</th><th class="n">Score</th><th class="n">FOIR</th><th class="n">Late pmts</th><th class="n">Confidence</th>${o ? "<th>Bank decision</th>" : ""}</tr>${topRows}</table></div>` : "<p>No applications in this file reached the auto-decline threshold.</p>"}

  <h2>8. Recommendations</h2>
  <ul>
    <li>Send the ${int(m.lanes.review + m.lanes.human)} analyst-lane applications to the queue; spot-check a sample of the ${int(m.lanes.decline)} automatic declines before notifying applicants.</li>
    ${o && o.wrongRate > 0.05 ? "<li>This file breaks the 5% rule. Raise the threshold on the Threshold tab before using automatic declines on similar files.</li>" : ""}
    ${unk ? "<li>Correct the unrecognised category values and re-upload the file so every application is scored on known inputs.</li>" : ""}
    ${m.fairness && m.fairness.female.rate !== null && m.fairness.male.rate !== null && Math.abs(m.fairness.female.rate - m.fairness.male.rate) > 0.05 ? "<li>The gender gap in auto-decline rates is above 5 points. Review it with the credit risk team.</li>" : ""}
    <li>Link automatic declines to repayment outcomes when they become available, so the model can be judged on repayment rather than on past decisions.</li>
  </ul>

  <h2>9. Limitations</h2>
  <ul>
    <li>The model copies past analyst decisions, not repayment. Any mistakes or bias in those decisions are built in.</li>
    <li>It is weak for new-to-credit applicants (56.7% accuracy), so they are never auto-declined.</li>
    <li>Trained on six months of one bank's simulated data (April–September 2026). Re-test on newer applications before live use.</li>
    <li>Category values the model has not seen are scored as neutral, without a separate warning in the score.</li>
    <li>Coursework for Calibo AI Academy MUC02. It makes no lending decision about real people.</li>
  </ul>
</article>`;
  }

  // ---------- Markdown ----------
  function markdown(m) {
    const o = m.outcome, L = [];
    const row = cells => "| " + cells.join(" | ") + " |";
    L.push(`# Intake triage report`, "", `${m.file} · ${int(m.n)} applications · ${policyLine(m)} · model ${m.model.version} · generated ${m.generated.toLocaleString("en-IN", {dateStyle: "medium", timeStyle: "short"})}${m.author ? ` · prepared by ${m.author}` : ""}`, "");
    L.push("## Key findings", "", ...m.findings.map(f => `- **${f.tag}**: ${f.tx} _(${f.ev})_`), "");
    L.push("## Lane outcomes", "", row(["Lane", "Applications", "Share", "Hours freed"]), row(["---", "---:", "---:", "---:"]),
      ...Object.keys(LANE).map(k => row([LANE[k], int(m.lanes[k]), pct(m.lanes[k] / m.n), k === "decline" ? int(m.hours) : "–"])), "");
    L.push("## Policy applied", "", `- Auto-decline threshold: ${m.policy.threshold.toFixed(2)}, only with a bureau score`, `- New to credit: ${m.policy.route_ntc ? "analyst-only lane" : "normal analyst queue"}`,
      `- Expected on the test set: ${pct(m.test.share)} auto-declined, ${pct(m.test.wrongRate)} wrongly declined`, "");
    L.push("## Data checks", "", `- Incomes treated as annual: ${m.fixed}`, `- Blank incomes filled: ${m.filled}`, `- New to credit: ${m.ntc}`,
      `- Unrecognised employment types: ${m.unknown.employment_type}`, `- Unrecognised loan purposes: ${m.unknown.loan_purpose}`, "");
    if (o) L.push("## Check against the bank's decisions", "", `- Wrong declines: ${o.wrong} of ${m.lanes.decline} (${pct(o.wrongRate)}), ${o.wrongRate <= 0.05 ? "inside" : "above"} the 5% limit`,
      `- Bank declines caught automatically: ${o.caught} of ${o.bankDeclined} (${pct(o.caughtShare)})`, "");
    if (m.fairness) L.push("## Fairness monitor", "", `- Female: ${m.fairness.female.rate === null ? "–" : pct(m.fairness.female.rate)} auto-declined (${m.fairness.female.n} applications)`,
      `- Male: ${m.fairness.male.rate === null ? "–" : pct(m.fairness.male.rate)} auto-declined (${m.fairness.male.n} applications)`, "");
    L.push("## By employment type", "", row(["Employment type", "Applications", "Auto-declined", "Rate"]), row(["---", "---:", "---:", "---:"]),
      ...m.byEmployment.map(g => row([g.name, int(g.n), int(g.auto), pct(g.rate)])), "");
    if (m.top.length) L.push("## Highest-confidence automatic declines", "", row(["Application", "Employment", "Income ₹", "Score", "Confidence"]), row(["---", "---", "---:", "---:", "---:"]),
      ...m.top.map(r => row([String(r._id), String(r.employment_type), int(r._inc), String(r.credit_score ?? "–"), pct(r._p)])), "");
    L.push("## Limitations", "", "- The model copies past analyst decisions, not repayment.", "- Weak for new-to-credit applicants (56.7% accuracy), so they are never auto-declined.",
      "- Trained on six months of one bank's simulated data. Re-test before live use.", "- Unseen category values are scored as neutral.", "- Coursework; makes no lending decision about real people.", "");
    return L.join("\n");
  }

  // Wide tables scroll inside their own box on phones instead of widening the page
  const htmlScrollable = m => html(m).replace(/<div class="tscroll"><table>/g, "<table>").replace(/<table>/g, '<div class="tscroll"><table>').replace(/<\/table>(<\/div>)?/g, "</table></div>");

  root.TriageReport = {build, html: htmlScrollable, markdown};
})(typeof self !== "undefined" ? self : this);
