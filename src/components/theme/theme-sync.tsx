"use client";

import { useEffect, useRef } from "react";

import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/hooks/use-theme";
import { createClient } from "@/lib/supabase/client";
import { isMode, isThemeId, type Mode, type ThemeId } from "@/lib/themes";

interface Appearance {
  theme: ThemeId;
  mode: Mode;
}

/**
 * Keeps the theme with the person, not just the browser. The theme
 * hook stores it in localStorage (so pages paint correctly before
 * anything loads); this mirrors it to the signed-in member's profile:
 *
 *   • once the profile loads, a saved choice is applied on this device
 *     (or, when nothing is saved yet, this device's choice is saved);
 *   • after that, every change the member makes is written back.
 *
 * Headless. Mount once inside both the auth and theme providers.
 */
export function ThemeSync() {
  const { user, profile } = useAuth();
  const { theme, mode, setTheme, setMode } = useTheme();
  // What the profile holds. null until the profile has loaded.
  const stored = useRef<Appearance | null>(null);
  // Set while the saved choice is being applied: the theme state still
  // shows this device's old value, which must not be written back.
  const applying = useRef<Appearance | null>(null);

  useEffect(() => {
    if (!profile || !user || stored.current) return;
    const saved: Appearance = {
      theme: isThemeId(profile.theme) ? profile.theme : theme,
      mode: isMode(profile.color_mode) ? profile.color_mode : mode,
    };
    stored.current = {
      theme: isThemeId(profile.theme) ? profile.theme : ("" as ThemeId),
      mode: isMode(profile.color_mode) ? profile.color_mode : ("" as Mode),
    };
    if (saved.theme !== theme || saved.mode !== mode) {
      applying.current = saved;
      if (saved.theme !== theme) setTheme(saved.theme);
      if (saved.mode !== mode) setMode(saved.mode);
    }
    // Once per sign-in; theme/mode are read here, not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, user]);

  useEffect(() => {
    if (!user || !stored.current) return;
    if (applying.current) {
      if (applying.current.theme !== theme || applying.current.mode !== mode) return;
      applying.current = null;
    }
    if (stored.current.theme === theme && stored.current.mode === mode) return;
    stored.current = { theme, mode };
    void createClient()
      .from("profiles")
      .update({ theme, color_mode: mode })
      .eq("user_id", user.id)
      .then(({ error }) => {
        if (error) console.error("[theme] saving to profile failed:", error.message);
      });
    // `profile`: also runs right after the first effect, to save this
    // device's choice when the profile had none.
  }, [theme, mode, user, profile]);

  return null;
}
