/* Supabase client + helpers shared by login.html and app.html.
   Only the anon key is used; row-level security in supabase/schema.sql decides what each user can touch. */
(function () {
  "use strict";
  const cfg = window.TRIAGE_CONFIG || {};
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(cfg.SUPABASE_URL || "")
    && !!cfg.SUPABASE_ANON_KEY && !/^YOUR_/.test(cfg.SUPABASE_ANON_KEY);
  const client = configured && window.supabase
    ? window.supabase.createClient(cfg.SUPABASE_URL.replace(/\/$/, ""), cfg.SUPABASE_ANON_KEY,
        {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: true}})
    : null;

  async function getSession() {
    if (!client) return null;
    try { const {data} = await client.auth.getSession(); return data.session || null; }
    catch (e) { return null; }
  }

  // Only same-site paths are allowed as post-login destinations
  function safeNext(v, fallback) {
    return typeof v === "string" && /^\/(?!\/)[\w\-./?=&#%]*$/.test(v) && !v.startsWith("/login") ? v : (fallback || "/app");
  }

  // Map Supabase / Postgres errors to sentences a credit analyst can act on
  function friendly(e) {
    const m = (e && (e.message || e.error_description || e.msg)) || String(e || "");
    const code = e && (e.code || e.error_code);
    if (/SCORING_LIMIT_REACHED/.test(m)) return "You have 50 saved scorings. Delete one to save another.";
    if (/BATCH_LIMIT_REACHED/.test(m)) return "You have 5 saved batches. Delete one to save another.";
    if (/Invalid login credentials/i.test(m)) return "That email and password don't match an account.";
    if (/Email not confirmed/i.test(m)) return "Confirm your email first: open the link we sent when you signed up.";
    if (/already registered|already been registered/i.test(m)) return "An account with this email already exists. Sign in instead.";
    if (/Password should be at least (\d+)/i.test(m)) return `Use at least ${m.match(/at least (\d+)/i)[1]} characters for your password.`;
    if (/weak|pwned|known to be/i.test(m)) return "That password is too easy to guess. Choose a longer or less common one.";
    if (/same.*password|different from the old/i.test(m)) return "Choose a password different from your current one.";
    if (/rate limit|For security purposes|too many/i.test(m) || code === "over_request_rate_limit" || code === "over_email_send_rate_limit")
      return "Too many attempts. Wait a minute and try again.";
    if (/provider is not enabled|Unsupported provider/i.test(m)) return "Google sign-in isn't switched on for this project yet. Use email and password.";
    if (/row-level security|violates row-level/i.test(m)) return "Your file storage is full or not yours. Delete a saved batch and try again.";
    if (code === "PGRST205" || code === "42P01" || /schema cache|does not exist/i.test(m))
      return "The database isn't set up yet. Run supabase/schema.sql in the Supabase SQL editor.";
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) return "Can't reach the server. Check your connection and try again.";
    if (/JWT|session.*(missing|expired)|not authenticated/i.test(m)) return "Your session has ended. Sign in again.";
    if (/Payload too large|exceeded the maximum allowed size/i.test(m)) return "That file is larger than 10 MB.";
    return m || "Something went wrong. Try again.";
  }

  window.TriageBackend = {configured, client, getSession, safeNext, friendly, url: cfg.SUPABASE_URL, key: cfg.SUPABASE_ANON_KEY};
})();
