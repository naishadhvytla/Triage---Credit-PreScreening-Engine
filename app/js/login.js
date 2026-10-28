/* /login: sign in, create account, forgot password, set a new password (from the reset email), Google sign-in. */
(function () {
  "use strict";
  const B = window.TriageBackend;
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const next = B.safeNext(params.get("next"), "/app");
  const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
  const MIN_PW = 8;

  const COPY = {
    signin: {title: "Welcome back", sub: "Sign in to score applications, keep your policy and see your history.", submit: "Sign in", busy: "Signing in…"},
    signup: {title: "Create your account", sub: "Free. Your saved scorings, batches and policy stay private to you.", submit: "Create account", busy: "Creating account…"},
    forgot: {title: "Reset your password", sub: "Enter your account email and we'll send you a link to set a new password.", submit: "Send reset link", busy: "Sending…"},
    reset: {title: "Choose a new password", sub: "You're signed in from the reset link. Set a new password to finish.", submit: "Save new password", busy: "Saving…"},
  };
  let mode = "signin", touched = false, busy = false;

  function alertMsg(text, kind) {
    const a = $("alert");
    if (!text) { a.hidden = true; a.textContent = ""; return; }
    a.className = "alert " + (kind || "bad"); a.textContent = text; a.hidden = false;
  }

  function setMode(m, opts) {
    mode = m; touched = false;
    const c = COPY[m];
    $("title").textContent = c.title; $("subtitle").textContent = c.sub; $("submit").textContent = c.submit;
    $("switch").hidden = m === "forgot" || m === "reset";
    $("tab-signin").setAttribute("aria-selected", m === "signin"); $("tab-signup").setAttribute("aria-selected", m === "signup");
    $("tab-signin").tabIndex = m === "signin" ? 0 : -1; $("tab-signup").tabIndex = m === "signup" ? 0 : -1;
    $("f-name").hidden = m !== "signup";
    $("f-email").hidden = m === "reset";
    $("f-password").hidden = m === "forgot";
    $("forgotLink").hidden = m !== "signin";
    $("password-hint").hidden = !(m === "signup" || m === "reset");
    $("password-label").textContent = m === "reset" ? "New password" : "Password";
    $("password").autocomplete = m === "signin" ? "current-password" : "new-password";
    $("googleBlock").hidden = m === "forgot" || m === "reset";
    const foot = $("foot");
    foot.innerHTML = "";
    if (m === "signin" || m === "signup") {
      foot.append(m === "signin" ? "New to Triage? " : "Already have an account? ");
      const b = document.createElement("button"); b.type = "button"; b.className = "linkbtn";
      b.textContent = m === "signin" ? "Create an account" : "Sign in"; b.addEventListener("click", () => setMode(m === "signin" ? "signup" : "signin", {focus: true}));
      foot.append(b);
    } else if (m === "forgot") {
      const b = document.createElement("button"); b.type = "button"; b.className = "linkbtn"; b.textContent = "Back to sign in";
      b.addEventListener("click", () => setMode("signin", {focus: true})); foot.append(b);
    }
    ["email", "password"].forEach(clearErr);
    if (!(opts && opts.keepAlert)) alertMsg("");
    // Keep the hash: supabase-js reads reset/OAuth tokens from it asynchronously and clears it itself
    const u = new URL(location.href);
    if (m === "signin") u.searchParams.delete("mode"); else u.searchParams.set("mode", m);
    history.replaceState(null, "", u.pathname + u.search + u.hash);
    if (opts && opts.focus) (m === "reset" ? $("password") : $("email")).focus();
  }

  function setErr(id, msg) { const i = $(id); i.setAttribute("aria-invalid", "true"); $(id + "-err").textContent = msg; }
  function clearErr(id) { $(id).removeAttribute("aria-invalid"); $(id + "-err").textContent = ""; }

  // Returns the first invalid field, or null
  function validate() {
    let first = null;
    const email = $("email").value.trim(), pw = $("password").value;
    if (mode !== "reset") {
      if (!email) { setErr("email", "Enter your email address."); first = first || "email"; }
      else if (!EMAIL_RE.test(email)) { setErr("email", "Enter a valid email address, like name@bank.com."); first = first || "email"; }
      else clearErr("email");
    }
    if (mode !== "forgot") {
      if (!pw) { setErr("password", mode === "reset" ? "Enter a new password." : "Enter your password."); first = first || "password"; }
      else if ((mode === "signup" || mode === "reset") && pw.length < MIN_PW) { setErr("password", `Use at least ${MIN_PW} characters.`); first = first || "password"; }
      else clearErr("password");
    }
    return first;
  }

  function setBusy(on) {
    busy = on;
    const s = $("submit");
    s.disabled = on; $("google").disabled = on;
    s.setAttribute("aria-busy", on);
    s.innerHTML = on ? `<span class="spin" aria-hidden="true"></span>${COPY[mode].busy}` : COPY[mode].submit;
  }

  function go(path) { location.replace(path); }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    touched = true; alertMsg("");
    const bad = validate();
    if (bad) { $(bad).focus(); return; }
    if (!B.client) { alertMsg("Triage isn't connected to its database yet. Fill in app/config.js (see the README)."); return; }
    const email = $("email").value.trim(), password = $("password").value, sb = B.client;
    setBusy(true);
    try {
      if (mode === "signin") {
        const {error} = await sb.auth.signInWithPassword({email, password});
        if (error) throw error;
        return go(next);
      }
      if (mode === "signup") {
        const display_name = $("name").value.trim();
        const {data, error} = await sb.auth.signUp({email, password, options: {data: {display_name}, emailRedirectTo: location.origin + next}});
        if (error) throw error;
        if (data.session) return go(next);
        setMode("signin", {keepAlert: true});
        $("email").value = email;
        alertMsg(`Check your inbox at ${email}. Open the confirmation link, then sign in here. If you already have an account, sign in or reset your password.`, "ok");
        return;
      }
      if (mode === "forgot") {
        const {error} = await sb.auth.resetPasswordForEmail(email, {redirectTo: location.origin + "/login?mode=reset"});
        if (error) throw error;
        alertMsg(`If an account exists for ${email}, a reset link is on its way. It works once and expires in an hour.`, "ok");
        return;
      }
      if (mode === "reset") {
        const {error} = await sb.auth.updateUser({password});
        if (error) throw error;
        alertMsg("Password updated. Opening Triage…", "ok");
        setTimeout(() => go(next), 700);
      }
    } catch (err) {
      alertMsg(B.friendly(err));
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    alertMsg("");
    if (!B.client) { alertMsg("Triage isn't connected to its database yet. Fill in app/config.js (see the README)."); return; }
    setBusy(true);
    try {
      // Check the provider is on first, so a misconfigured project shows a clear message instead of a raw JSON error page
      const res = await fetch(B.url.replace(/\/$/, "") + "/auth/v1/settings", {headers: {apikey: B.key}});
      const s = res.ok ? await res.json() : null;
      if (s && s.external && s.external.google === false) throw new Error("provider is not enabled");
      const {error} = await B.client.auth.signInWithOAuth({provider: "google", options: {redirectTo: location.origin + next}});
      if (error) throw error;
    } catch (err) {
      alertMsg(B.friendly(err)); setBusy(false);
    }
  }

  // ---------- wiring ----------
  $("authForm").addEventListener("submit", submit);
  $("authForm").addEventListener("input", e => { if (touched && (e.target.id === "email" || e.target.id === "password")) validate(); });
  $("authForm").addEventListener("focusout", e => { if (touched && (e.target.id === "email" || e.target.id === "password")) validate(); });
  $("google").addEventListener("click", google);
  $("forgotLink").addEventListener("click", () => { const em = $("email").value; setMode("forgot", {focus: true}); $("email").value = em; });
  $("tab-signin").addEventListener("click", () => setMode("signin"));
  $("tab-signup").addEventListener("click", () => setMode("signup"));
  $("switch").addEventListener("keydown", e => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const to = mode === "signin" ? "signup" : "signin";
    setMode(to); $("tab-" + to).focus();
  });
  $("pwToggle").addEventListener("click", () => {
    const i = $("password"), show = i.type === "password";
    i.type = show ? "text" : "password";
    $("pwToggle").textContent = show ? "Hide" : "Show";
    $("pwToggle").setAttribute("aria-pressed", show);
    $("pwToggle").setAttribute("aria-label", show ? "Hide password" : "Show password");
  });
  $("pwToggle").setAttribute("aria-label", "Show password");

  // ---------- start ----------
  const recovery = hash.get("type") === "recovery" || params.get("mode") === "reset";
  const linkError = hash.get("error_description") || params.get("error_description");
  const wanted = params.get("mode");
  setMode(recovery ? "reset" : (COPY[wanted] && wanted !== "reset" ? wanted : "signin"));
  if (linkError) {
    alertMsg(/expired|invalid/i.test(linkError) ? "That link has expired or was already used. Request a new one below." : linkError.replace(/\+/g, " "));
    if (recovery) setMode("forgot", {keepAlert: true});
  }
  if (!B.configured) alertMsg("Triage isn't connected to its database yet. Fill in app/config.js (see the README).", "info");

  if (B.client) {
    B.client.auth.onAuthStateChange(evt => { if (evt === "PASSWORD_RECOVERY") setMode("reset", {focus: true}); });
    B.getSession().then(session => {
      if (!session) {
        if (mode === "reset" && !linkError) { setMode("forgot", {keepAlert: true}); alertMsg("Open the reset link from your email to set a new password, or request a new link.", "info"); }
        return;
      }
      if (mode !== "reset") go(next);   // already signed in: straight to the app
    });
  }
})();
