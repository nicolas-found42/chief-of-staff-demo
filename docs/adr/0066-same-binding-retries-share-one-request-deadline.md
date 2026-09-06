# Same-binding retries share one request deadline

Issue #228 observed an OpenRouter stream that produced partial tool arguments, then only transport
keepalive comments until its idle timeout. Its cause remains unknown. A request may opt into one
additional attempt on the same binding to recover from a transient idle or transport failure,
while retaining the original failure even when the next attempt succeeds.

The opt-in requires a sanitized attempt observer. It applies to the shared OpenAI-compatible
completion loop used by OpenRouter and Ollama; the other providers keep their fixed request policy.
Each actual completion request receives a wire-attempt ordinal, binding, outcome, diagnostic when
available, retry delay, and reason recovery stopped. The absolute deadline reports its terminal
event before returning, so a racing timeout cannot erase the last attempt. These are wire attempts,
not additional logical model calls. Existing binding recovery attempts are also visible when the
observer is enabled.

Only a classified transport failure or the thirty-second streaming idle timeout qualifies. Before
retrying, the failed stream is aborted and at least 30,500 ms must remain in the original 120-second
request deadline. Backoff is fixed at 500 ms; the deadline and an optional caller lifecycle gate
are checked again afterward. Retry reuses the same model, binding, routing parameters, prompts,
sampling parameters, and full Result Shape. Partial answers from separate attempts never combine.

There is one additional same-binding attempt per logical call, not one per binding rung. Ordinary
declared-binding refusals, malformed answers, and the absolute request timeout do not retry.
ADR-0064's repetition recovery and the existing unknown-support refusal ladder remain separate,
share the same absolute deadline, and cannot reset the retry allowance. Without the opt-in, the
existing failure policy remains unchanged. Cancellation of the caller's retry gate prevents another
request; it does not claim to cancel a provider request already in flight.

This extends ADR-0029 and ADR-0065 without interpreting a timeout as evidence that a weaker binding
is supported. Successful recovery still requires normal answer parsing, caller validation, and
research completion checks. It does not by itself establish live benchmark quality acceptance.
