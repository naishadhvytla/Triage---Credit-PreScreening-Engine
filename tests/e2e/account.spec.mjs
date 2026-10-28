// Signed-in smoke tests against the real Supabase project in app/config.js, with a test account:
//   TRIAGE_TEST_EMAIL / TRIAGE_TEST_PASSWORD (environment or .env). Everything a test saves, it deletes again.
import {test, expect} from "@playwright/test";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const TriageModel = require("../../app/js/model.js");
const MODEL = JSON.parse(readFileSync(new URL("../../app/model.json", import.meta.url)));
const SAMPLE = new URL("../../app/sample_batch.csv", import.meta.url).pathname;

const EMAIL = process.env.TRIAGE_TEST_EMAIL, PASSWORD = process.env.TRIAGE_TEST_PASSWORD;
test.skip(!EMAIL || !PASSWORD, "set TRIAGE_TEST_EMAIL and TRIAGE_TEST_PASSWORD to run the signed-in tests");
test.describe.configure({mode: "serial"});   // one account, so one test at a time
test.beforeEach(({}, info) => { test.skip(info.project.name !== "desktop", "signed-in tests run once, on desktop"); });

async function signIn(page) {
  await page.goto("/login?next=/app%23score");
  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill(PASSWORD);
  await page.locator("#submit").click();
  await expect(page).toHaveURL(/\/app#score/);
  await expect(page.locator("#acctBtn")).not.toHaveText("?");
}

// Lane counts the model gives the sample file under a policy (simple CSV split: the sample has no quoted commas)
function expectedLanes(threshold, routeNtc) {
  const m = TriageModel.create(MODEL);
  const [head, ...lines] = readFileSync(SAMPLE, "utf8").trim().split("\n");
  const cols = head.split(",");
  const counts = {decline: 0, review: 0, human: 0};
  for (const line of lines) {
    const v = line.split(","), row = {};
    cols.forEach((c, i) => { const x = v[i]; row[c] = x === "" ? null : (isNaN(x) ? x : +x); });
    const {p, r} = m.score(row);
    counts[m.laneOf(p, r.is_ntc, {threshold, route_ntc: routeNtc})]++;
  }
  return counts;
}

test("signed-in users who open /login go straight to the app", async ({page}) => {
  await signIn(page);
  await page.goto("/login");
  await expect(page).toHaveURL(/\/app/);
});

test("score → save → appears in History → delete", async ({page}) => {
  await signIn(page);
  const note = "e2e " + Date.now();
  await page.getByRole("button", {name: "Example: clear decline"}).click();
  await expect(page.locator("#laneTag")).toHaveText("Auto-decline");
  await page.locator("#note").fill(note);
  await page.getByRole("button", {name: "Save to history"}).click();
  await expect(page.locator("#saveStatus")).toContainText("Saved: Auto-decline");

  await page.getByRole("tab", {name: "History"}).click();
  await page.getByRole("searchbox", {name: "Search history"}).fill(note);
  const item = page.locator(".hitem[data-kind=scoring]", {hasText: note});
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("Auto-decline");

  // Re-open fills the Score form again
  await item.getByRole("button", {name: "Re-open"}).click();
  await expect(page.locator("#openBannerText")).toContainText(note);
  await expect(page.locator("#employment_type")).toHaveValue("Gig / Contract");

  await page.getByRole("tab", {name: "History"}).click();
  await page.getByRole("searchbox", {name: "Search history"}).fill(note);
  await item.getByRole("button", {name: "Delete"}).click();
  await item.getByRole("button", {name: "Yes, delete"}).click();
  await expect(page.locator(".hitem", {hasText: note})).toHaveCount(0);
});

test("batch upload of sample_batch.csv → lane counts shown, saved, then deleted", async ({page}) => {
  await signIn(page);
  await page.getByRole("tab", {name: "Batch"}).click();
  await page.locator("#file").setInputFiles(SAMPLE);
  await expect(page.locator("#dropMsg")).toContainText("sample_batch.csv: 240 applications scored.");

  const thr = await page.locator("#batchThr").textContent();
  const [, t, route] = thr.match(/Threshold ([\d.]+) · new to credit → (analyst only|analyst queue)/);
  const want = expectedLanes(+t, route === "analyst only");
  for (const [lane, n] of Object.entries(want)) await expect(page.locator(`#laneBody tr[data-lane=${lane}] td.n`).first()).toHaveText(String(n));
  if (+t === 0.9 && route === "analyst only") expect(want).toEqual({decline: 46, review: 180, human: 14});

  await expect(page.locator("#batchStatus")).toContainText("Saved to History", {timeout: 20_000});

  await page.getByRole("tab", {name: "History"}).click();
  const item = page.locator(".hitem[data-kind=batch]", {hasText: "sample_batch.csv"}).first();
  await expect(item).toContainText("240 applications");
  await expect(item).toContainText(`${want.decline} auto-declined`);
  await item.getByRole("button", {name: "Delete"}).click();
  await item.getByRole("button", {name: "Yes, delete"}).click();
  await expect(page.locator("#toast")).toContainText("Batch and its file deleted");
});

test("report tab summarises the current batch and exports it", async ({page}) => {
  await signIn(page);
  await page.getByRole("tab", {name: "Report"}).click();
  await expect(page.locator("#repSource")).toHaveText("the sample batch");
  const thr = await page.locator(".rp-sub").textContent();
  const [, t, route] = thr.match(/threshold ([\d.]+) · new to credit → (analyst only|analyst queue)/);
  const want = expectedLanes(+t, route === "analyst only");
  await expect(page.locator(".rp-kpi b").nth(1)).toHaveText(String(want.decline));
  await expect(page.locator(".rp-doc h2")).toHaveCount(10);
  await expect(page.locator(".rp-finding").first()).toContainText(`${want.decline} of 240 applications`);
  const [md] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", {name: "Markdown"}).click()]);
  expect(md.suggestedFilename()).toBe("Sample_batch_report.md");
  const [html] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", {name: "Visual HTML"}).click()]);
  expect(html.suggestedFilename()).toBe("Sample_batch_report.html");
});

test("sign out returns to /login and the app is closed again", async ({page}) => {
  await signIn(page);
  await page.locator("#acctBtn").click();
  await expect(page.locator("#acctEmail")).toHaveText(EMAIL);
  await page.getByRole("button", {name: "Sign out"}).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login\?next=/);
});
