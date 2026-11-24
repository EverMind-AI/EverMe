import { boundedDiagnostic, requestMeta } from "../client.js";
import { PROFILE_MAX_CHARS, PROFILE_MAX_ITEMS } from "../prompt.js";
import { profileTag } from "../brand.js";

export async function runSessionStart({ client, config, log }) {
  const { result, requestId } = await requestMeta(client, "POST", "/mem/context", {});
  const profile = result?.profile;
  const count = profileItemCount(profile);
  // One line per profile injection so a SessionStart can be located in ELK
  // by its trace id — errors already carry it via the degraded diagnostic.
  log?.info?.(`[everme] memory-context stage=complete result=success items=${count} requestId=${boundedDiagnostic(requestId, 128)}`);
  return {
    block: renderProfileBlock(profile, config?.brand),
    count,
    requestId,
  };
}

export function renderProfileBlock(profile, brand) {
  if (!profile) return "";
  const explicit = Array.isArray(profile.explicit_info) ? profile.explicit_info : [];
  const implicit = Array.isArray(profile.implicit_traits) ? profile.implicit_traits : [];
  if (!explicit.length && !implicit.length) return "";

  // One budget shared by both sections, spent facts-first. A profile large
  // enough to starve the traits section is far beyond anything observed;
  // the cap exists so a runaway profile cannot dominate the session prompt.
  const shownExplicit = explicit.slice(0, PROFILE_MAX_ITEMS);
  const shownImplicit = implicit.slice(0, Math.max(0, PROFILE_MAX_ITEMS - shownExplicit.length));

  const tag = profileTag(brand);
  const lines = [`<${tag}>`];
  if (shownExplicit.length) {
    lines.push("Profile facts:");
    for (const item of shownExplicit) {
      const description = item?.description || item?.evidence || "";
      if (!description) continue;
      const category = item.category ? `[${item.category}] ` : "";
      lines.push(`- ${category}${truncate(description, PROFILE_MAX_CHARS)}`);
    }
  }
  if (shownImplicit.length) {
    lines.push("Implicit traits:");
    for (const item of shownImplicit) {
      const name = item?.trait || item?.name || "trait";
      lines.push(`- ${name}: ${truncate(item?.description || "", PROFILE_MAX_CHARS)}`);
    }
  }
  lines.push(`</${tag}>`);
  return lines.join("\n");
}

export function profileItemCount(profile) {
  if (!profile) return 0;
  return (
    (Array.isArray(profile.explicit_info) ? profile.explicit_info.length : 0) +
    (Array.isArray(profile.implicit_traits) ? profile.implicit_traits.length : 0)
  );
}

function truncate(value, maxLength) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
