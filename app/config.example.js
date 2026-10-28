// Copy to app/config.js and fill in from Supabase → Project Settings → API.
// Both values are public by design: the anon key can only do what the row-level security in supabase/schema.sql allows.
// Never put the service_role key here.
window.TRIAGE_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_SUPABASE_ANON_KEY",
};
