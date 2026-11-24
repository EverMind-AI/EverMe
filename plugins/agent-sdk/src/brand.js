// EverMe and EverOS can both be installed in one host. Each plugin instance
// learns its brand from EVERME_BRAND in its own credential file and wraps
// what it injects in that brand's tags; every instance strips both brands'
// tags, so neither stores the other's recall as new memory.

export const BRANDS = ["everme", "everos"];

export function brandOf(env = {}) {
  return env.EVERME_BRAND === "everos" ? "everos" : "everme";
}

export function recallTag(brand) {
  return `${brand === "everos" ? "everos" : "everme"}_recall`;
}

export function profileTag(brand) {
  return `${brand === "everos" ? "everos" : "everme"}_profile`;
}

export const INJECTED_TAGS = BRANDS.flatMap((b) => [`${b}_recall`, `${b}_profile`]);

// brandStrings rewrites the user-facing EverMe wording and tag names in a
// string, or in every string of an object or array, for an EverOS
// instance. EverMe text is returned unchanged.
export function brandStrings(value, brand) {
  if (brand !== "everos") return value;
  if (typeof value === "string") {
    return value.replace(/everme_(recall|profile)/g, "everos_$1").replace(/EverMe/g, "EverOS");
  }
  if (Array.isArray(value)) return value.map((item) => brandStrings(item, brand));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, brandStrings(item, brand)]));
  }
  return value;
}
