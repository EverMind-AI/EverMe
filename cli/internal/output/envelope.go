package output

// Envelope is the canonical success-shape returned by every command in
// --format json | yaml mode (see docs/contracts.md).
//
// Field-level rules:
//   - Ok is always true on success; AI Agents treat it as the primary success key.
//   - Data is required and command-specific (per-command schemas in 99 appendix).
//   - Meta is optional; populated when count / requestId apply.
//
// The shape is part of the stable ABI. Changing field names or types is a
// breaking change. The Notice channel (system-level hints / update
// banners / deprecation warnings) was retired in the slimming pass
// alongside the `update` command; reintroduce when the deprecation /
// banner workflow is needed again.
type Envelope struct {
	Ok   bool        `json:"ok" yaml:"ok"`
	Data interface{} `json:"data" yaml:"data"`
	Meta *Meta       `json:"meta,omitempty" yaml:"meta,omitempty"`
}

// ErrorEnvelope is the canonical failure-shape. Mirror of Envelope but
// carrying an ErrorBody instead of Data.
type ErrorEnvelope struct {
	Ok    bool      `json:"ok" yaml:"ok"`
	Error ErrorBody `json:"error" yaml:"error"`
	Meta  *Meta     `json:"meta,omitempty" yaml:"meta,omitempty"`
}

// ErrorBody is the structured error payload. Type+Message are required;
// Code is the upstream errno (3xxxx/4xxxx/5xxxx) when the failure came
// from EverMe; Hint is the next-step suggestion to feed an Agent;
// Detail carries type-specific structured data (e.g. apiKeyPrefix, agent).
//
// See docs/contracts.md for the public type taxonomy.
type ErrorBody struct {
	Type    ErrorType              `json:"type" yaml:"type"`
	Code    int                    `json:"code,omitempty" yaml:"code,omitempty"`
	Message string                 `json:"message" yaml:"message"`
	Hint    string                 `json:"hint,omitempty" yaml:"hint,omitempty"`
	Detail  map[string]interface{} `json:"detail,omitempty" yaml:"detail,omitempty"`
}

// Meta holds out-of-band success metadata. Count is populated when the
// command returns a list; RequestID propagates the backend trace id when
// the command issued an EverMe call.
type Meta struct {
	Count     int    `json:"count,omitempty" yaml:"count,omitempty"`
	RequestID string `json:"requestId,omitempty" yaml:"requestId,omitempty"`
}

// (Notice / NoticeUpdate retired with `evercli update` and the
// plugin-uninstall partial-success warning. Add them back behind a
// concrete consumer when one shows up — keeping a notice channel
// without a producer was net negative for surface area.)
