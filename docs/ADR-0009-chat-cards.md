# ADR 0009: plugin action cards in the owner chat

Status: implemented in 0.3 RC. A live Bitrix24 chat-card scenario has passed on
stock Iva 0.5.7. Clean installation and the full failure matrix remain separate
acceptance steps; see [compatibility](COMPATIBILITY.md).

The plugin catalog is an administration and recovery surface, not a required step in
an ordinary business request. Plugins may ask Panels to present a verified v2 proposal
in the owner's current private bot chat. Panels knows no employee fields or REST methods.

A private local socket exposes only prepare-and-present, with no caller-selected recipient
or callback payload. The provider resolves the registered enabled/trusted plugin and its
descriptor. The plugin validates its own revision, data and policy and returns the proposal.
Panels records delivery intent before prepare/send, assigns its own callback identity and
binds confirmation to the delivered message, owner, chat, revision and lifetime. The existing
v2 confirm/cancel/status and plugin-owned durable jobs remain the only effect path.

Request IDs deduplicate sends across retries/restarts. An unknown send or prepare is not
replayed, even if no message ID was saved. This trades automatic recovery for avoiding a
second independently actionable card. Existing receipt and screen capacity limits apply.
The first implementation requires exactly one configured owner; caller-provided chat IDs
are deliberately unsupported until the host provides authenticated conversation context.

Raw trusted callbacks retain the existing ingress validation. Model-generated rich text,
forwarded content and plain assent never substitute for a callback bound to a delivered
screen. No core patches or MCP business apply endpoint are introduced.
