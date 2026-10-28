// Signed-out smoke tests: landing, login validation, auth redirect, 404, headers, layout.
import {test, expect} from "@playwright/test";

// Fail on any console error (CSP violations and script errors show up here)
test.beforeEach(async ({page}, info) => {
  info.consoleErrors = [];
  // Expected HTTP errors (a 404 page, Supabase rejecting a wrong password) are logged by the browser too; ignore just those
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource: .*status of (400|404)/.test(m.text())) info.consoleErrors.push(m.text()); });
  page.on("pageerror", e => info.consoleErrors.push(e.message));
});
test.afterEach(async ({}, info) => { expect(info.consoleErrors, "console errors").toEqual([]); });

const noHorizontalScroll = page => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test("landing loads with the three numbers and a live demo", async ({page}) => {
  const res = await page.goto("/");
  expect(res.status()).toBe(200);
  await expect(page).toHaveTitle(/Triage/);
  await expect(page.getByRole("heading", {level: 1})).toHaveText("Take the clear-cut declines out of the manual queue.");
  await expect(page.locator("#n1")).toHaveText("441");
  await expect(page.locator("#n2")).toHaveText("184");
  await expect(page.locator("#n3")).toHaveText("3.1%");
  await expect(page.getByRole("link", {name: "Create a free account"})).toHaveAttribute("href", "/login?mode=signup");

  // Demo: borderline example starts in analyst review, a weaker file becomes an auto-decline, no history goes to a person
  const lane = page.locator("#dLane");
  await expect(lane).toHaveClass(/review/);
  await expect(page.locator("#dProb")).toHaveText("78%");
  await page.locator("#dScore").fill("600");
  await page.locator("#dLate").selectOption("4");
  await expect(lane).toHaveClass(/decline/);
  await expect(page.locator("#dTag")).toHaveText("Auto-decline");
  await page.locator("#dNtc").check();
  await expect(lane).toHaveClass(/human/);
  expect(await noHorizontalScroll(page)).toBe(0);
});

test("security headers are sent", async ({request}) => {
  const res = await request.get("/");
  const h = res.headers();
  expect(h["content-security-policy"]).toContain("connect-src 'self' https://mvfukpufljkxjjhymtoa.supabase.co");
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect((await request.get("/src/build.py")).status()).toBe(404);
});

test("login page validates inline", async ({page}) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", {name: "Welcome back"})).toBeVisible();

  await page.getByRole("button", {name: "Sign in", exact: true}).last().click();
  await expect(page.locator("#email-err")).toHaveText("Enter your email address.");
  await expect(page.locator("#password-err")).toHaveText("Enter your password.");
  await expect(page.locator("#email")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#email")).toBeFocused();

  await page.locator("#email").fill("not-an-email");
  await expect(page.locator("#email-err")).toHaveText(/valid email/);
  await page.locator("#email").fill("analyst@bank.example");
  await expect(page.locator("#email-err")).toHaveText("");

  await page.getByRole("tab", {name: "Create account"}).click();
  await expect(page.getByRole("heading", {name: "Create your account"})).toBeVisible();
  await expect(page).toHaveURL(/mode=signup/);
  await page.locator("#email").fill("analyst@bank.example");
  await page.locator("#password").fill("short");
  await page.locator("#submit").click();
  await expect(page.locator("#password-err")).toHaveText("Use at least 8 characters.");

  await page.getByRole("tab", {name: "Sign in"}).click();
  await page.getByRole("button", {name: "Forgot password?"}).click();
  await expect(page.getByRole("heading", {name: "Reset your password"})).toBeVisible();
  await expect(page.locator("#password")).toBeHidden();
  await expect(page.getByRole("button", {name: "Continue with Google"})).toBeHidden();
  expect(await noHorizontalScroll(page)).toBe(0);
});

test("wrong password shows a clear error and keeps the user on /login", async ({page}) => {
  await page.goto("/login");
  await page.locator("#email").fill("nobody-" + Date.now() + "@example.com");
  await page.locator("#password").fill("definitely-wrong-1");
  await page.locator("#submit").click();
  await expect(page.locator("#alert")).toHaveText("That email and password don't match an account.");
  await expect(page).toHaveURL(/\/login/);
});

test("the app redirects to /login when signed out", async ({page}) => {
  await page.goto("/app#history");
  await expect(page).toHaveURL(/\/login\?next=%2Fapp%23history$/);
  await expect(page.getByRole("heading", {name: "Welcome back"})).toBeVisible();
});

test("unknown pages get the 404 page", async ({page}) => {
  const res = await page.goto("/no-such-page");
  expect(res.status()).toBe(404);
  await expect(page.getByRole("heading", {level: 1})).toHaveText("This page isn't in the queue.");
});

test("keyboard: skip link comes first and focus is visible", async ({page, isMobile}) => {
  test.skip(isMobile, "keyboard check runs on desktop");
  await page.goto("/login");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", {name: "Skip to the form"});
  await expect(skip).toBeFocused();
  const outline = await skip.evaluate(el => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none");
});

test("theme toggle cycles and is remembered", async ({page}) => {
  await page.goto("/");
  const html = page.locator("html");
  await page.locator("[data-theme-toggle]").click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.locator("[data-theme-toggle]").click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
});
