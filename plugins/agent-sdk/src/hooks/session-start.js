import { requestMeta } from "../client.js";

export async function runSessionStart({ client, log }) {
  const { result, requestId } = await requestMeta(client, "POST", "/mem/context", {});
  const profile = result?.profile;
  const count = profileItemCount(profile);
  // One line per profile injection so a SessionStart can be located in ELK
  // by its trace id — errors already carry it via the degraded diagnostic.
  log?.info?.(`[everme] SessionStart profile: items=${count} requestId=${requestId}`);
  return {
    block: renderProfileBlock(profile),
    count,
    requestId,
  };
}

export function renderProfileBlock(profile) {
  if (!profile) return "";
  const explicit = Array.isArray(profile.explicit_info) ? profile.explicit_info : [];
  const implicit = Array.isArray(profile.implicit_traits) ? profile.implicit_traits : [];
  if (!explicit.length && !implicit.length) return "";

  const lines = ["<everme_profile>"];
  if (explicit.length) {
    lines.push("Profile facts:");
    for (const item of explicit.slice(0, 12)) {
      const description = item?.description || item?.evidence || "";
      if (!description) continue;
      const category = item.category ? `[${item.category}] ` : "";
      lines.push(`- ${category}${truncate(description, 240)}`);
    }
  }
  if (implicit.length) {
    lines.push("Implicit traits:");
    for (const item of implicit.slice(0, 6)) {
      const name = item?.trait || item?.name || "trait";
      lines.push(`- ${name}: ${truncate(item?.description || "", 200)}`);
    }
  }
  lines.push("</everme_profile>");
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
