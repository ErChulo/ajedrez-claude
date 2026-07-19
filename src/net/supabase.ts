// Supabase client wrapper.
//   - If VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY are absent, getSupabase() returns null.
//   - In that case, online mode must be disabled in the UI; local AI / pass-and-play still work.
//   - Callers should NEVER hard-fail if Supabase is missing — guard with `if (sb)`.
//
// The schema and RLS policies live in src/net/schema.sql and src/net/rls.sql and must be
// applied in your Supabase dashboard before turning online mode on (see SETUP.md).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;
let resolved = false;

export function supabaseUrl(): string { return import.meta.env.VITE_SUPABASE_URL ?? ""; }
export function supabaseAnonKey(): string { return import.meta.env.VITE_SUPABASE_ANON_KEY ?? ""; }

export function isSupabaseConfigured(): boolean {
  return Boolean(supabaseUrl() && supabaseAnonKey());
}

/** Lazily create + cache the Supabase client. Returns null if env is not set. */
export function getSupabase(): SupabaseClient | null {
  if (resolved) return cached;
  resolved = true;
  if (!isSupabaseConfigured()) {
    cached = null;
    return null;
  }
  cached = createClient(supabaseUrl(), supabaseAnonKey(), {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return cached;
}

export async function signInAnonymously(): Promise<{ userId: string } | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb.auth.signInAnonymously();
  if (error || !data?.user) return null;
  return { userId: data.user.id };
}

export async function currentUserId(): Promise<string | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getUser();
  return data?.user?.id ?? null;
}
