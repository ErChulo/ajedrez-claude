# SETUP — Supabase + Vercel deployment

You only need to do this once. After it's done, every push to `main` on GitHub
auto-deploys on Vercel.

## 0. Local prerequisites

- **Node.js 20+** (Vite 5 requirement).
- **`codegraph`** on `$PATH` (currently installed at `/home/erchulo/.local/bin/codegraph`,
  v1.4.1). Used by `AGENTS.md` recipes for cross-file navigation. If missing,
  request a system install or work around with `grep`/`rg` until then.
- *(Optional)* **Playwright browsers** are cached at `~/.cache/ms-playwright/`
  after the first install. Run `npm run e2e:install` to set them up.

The chess app itself runs without these; they're tooling for the dev workflow.
See [AGENTS.md](./AGENTS.md) for how they fit in.

## 1. Create a Supabase project

1. Go to <https://supabase.com> and sign up / sign in.
2. Click **"New project"**.
3. Pick a name (e.g. `ajedrez`), a strong database password, and the region
   closest to you.
4. Wait ~2 minutes for the project to provision.

## 2. Enable Anonymous sign-in

1. In your project, open **Authentication → Providers** in the left sidebar.
2. Find **Anonymous** in the list and toggle it on.
3. (Optional) Toggle on **Email / Apple / Google** if you want fallback flows.
4. Click **Save**.

> Anonymous sign-in lets visitors play without an account. The user-id is
> generated server-side as a UUID and is what Row Level Security uses to
> gate writes (see step 4 below).

## 3. Create the database schema

1. In your project, open **SQL Editor → New query** in the left sidebar.
2. Paste the entire contents of `src/net/schema.sql` and run it.
3. Open another **new query**.
4. Paste the entire contents of `src/net/rls.sql` and run it.

That last step enables Row Level Security on `games` and `moves`, and
defines the policies.

## 4. Enable Realtime

1. Open **Database → Replication** in the left sidebar.
2. Toggle on Realtime for both the `games` and `moves` tables.

Now any insert/update on these tables will push to subscribed clients
within ~1 second.

## 5. Grab your URL + anon key

1. Open **Project Settings → API** in the left sidebar.
2. Copy your **Project URL** (looks like `https://xxxxxxxxxxxx.supabase.co`).
3. Copy your **anon / public** key (a long JWT-style string under
   "Project API keys > anon public").

The anon key is **meant to be public** in a client app. Security comes
from RLS (which we just enabled), not from hiding this key.

## 6. Wire them into your local dev or Vercel

**For local dev:**

```bash
cp .env.example .env.local
# edit .env.local:
VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=ey...
npm run dev
```

**For Vercel:**

1. Open your Vercel project → **Settings → Environment Variables**.
2. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` with the same
   values.
3. Redeploy (or push to `main` again).

## 7. (Recommended but optional) Content-Security-Policy

To keep users safe from any embedded malicious scripts, add a `vercel.json`
like this at the repo root:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Content-Security-Policy",
          "value": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net; connect-src 'self' https://*.supabase.co wss://*.supabase.co;" }
      ]
    }
  ]
}
```

Adjust the script-src list to match the CDNs you actually use (Vite bundles
most things, so we don't strictly need any external script-src for this
app right now — but keep a tight policy and update it as you add scripts).

---

## Quick test

After you deploy, open your `*.vercel.app` URL in two different browsers
(or one normal + one incognito). You should be able to enter a name and
play a local AI game immediately. Online play requires a tiny multiplayer
UI to be added on top of the schema; the database is ready for it.

If you see attempts to insert moves failing, double-check:

- RLS is **enabled** (it is, by step 3).
- The user is signed in anonymously (handled automatically)
- The Security-Definer function `is_my_turn` exists (it's created by step 3).

---

That's it. Five minutes and you're on the board.
