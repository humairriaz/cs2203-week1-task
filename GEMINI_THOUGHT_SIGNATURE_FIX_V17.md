# Gemini Thought Signature Fix V17

Fixes Gemini 3 / 3.5 tool-calling failures such as:

`Function call is missing a thought_signature in functionCall parts.`

## Root cause
The streaming parser kept only `functionCall` and discarded Gemini's opaque `thoughtSignature`. Gemini 3 requires the signature to be replayed with the exact function-call part on the next tool round.

## Fix
- `GeminiPart` now retains `thoughtSignature` and `thought` metadata.
- Streaming responses preserve the complete signed tool-call part instead of rebuilding `{ functionCall }`.
- Signed/unsigned response parts are not merged before replay.
- Added a regression assertion to the self-test suite.

No dashboard, database, bridge, or permission behavior was broadened by this patch.
