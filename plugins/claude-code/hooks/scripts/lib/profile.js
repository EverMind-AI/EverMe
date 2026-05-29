/**
 * Renderers for the gateway's /mem/context profile snapshot.
 *
 * Profile shape (from EverMe gateway):
 *   { explicit_info: [{ category, description, evidence?, sources?[] }],
 *     implicit_traits: [{ trait, description, basis?, evidence? }],
 *     scenario, memcell_count, ... }
 *
 * `renderProfileBlock` is shared by:
 *   - SessionStart hook (kicks off the conversation with a snapshot)
 *   - UserPromptSubmit hook (fallback when search comes up empty)
 *
 * Centralising here so a tweak — wider truncation, extra fields, an
 * empty-state message — lands once instead of drifting between two
 * copies. The previous setup duplicated the whole function and we'd
 * already accumulated minor divergences (truncation lengths matched
 * but the function-name comments did not).
 */

/**
 * Render `profile` into a markdown block wrapped in <everme_profile>.
 * Returns "" when there's nothing to show — callers skip injection in
 * that case.
 */
export function renderProfileBlock(profile) {
  if (!profile) return "";
  const explicit = Array.isArray(profile.explicit_info) ? profile.explicit_info : [];
  const implicit = Array.isArray(profile.implicit_traits) ? profile.implicit_traits : [];
  if (explicit.length === 0 && implicit.length === 0) return "";

  const lines = ["<everme_profile>"];
  if (explicit.length > 0) {
    lines.push("Profile facts:");
    for (const e of explicit.slice(0, 12)) {
      const cat = e.category ? `[${e.category}] ` : "";
      const desc = e.description || e.evidence || "";
      if (!desc) continue;
      lines.push(`- ${cat}${truncate(desc, 240)}`);
    }
  }
  if (implicit.length > 0) {
    lines.push("Implicit traits:");
    for (const t of implicit.slice(0, 6)) {
      const name = t.trait || t.name || "trait";
      const desc = t.description || "";
      lines.push(`- ${name}: ${truncate(desc, 200)}`);
    }
  }
  lines.push("</everme_profile>");
  return lines.join("\n");
}

/**
 * Number of items the gateway included in this profile — used by the
 * hook output's `systemMessage` ("loaded N items"). Counts both the
 * explicit and implicit lists; matches what renderProfileBlock will
 * surface (modulo per-list truncation, which is fine for a count).
 */
export function profileItemCount(profile) {
  if (!profile) return 0;
  return (
    (Array.isArray(profile.explicit_info) ? profile.explicit_info.length : 0) +
    (Array.isArray(profile.implicit_traits) ? profile.implicit_traits.length : 0)
  );
}

/**
 * One-line truncation: collapse whitespace, cap to `n` chars, append
 * ellipsis. Both block renderers use the same shape so the output is
 * visually consistent across SessionStart and UserPromptSubmit.
 */
export function truncate(s, n) {
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
