# Installation owns shared credentials; Workspaces retain consent

The local Installation Operator provisions one Google OAuth client and provider-specific model
credentials for the running installation. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GEMINI_API_KEY` are loaded from
the process environment or a private gitignored `.env`; Ollama requires no key. The public
configuration boundary exposes only Configured, Missing, or Not required. A Workspace no longer
persists or accepts an editable `apiKey`, Google client ID, or Google client secret.

This amends ADR-0007's per-person OAuth-client custody. The shared client identifies the local
application; it does not identify or replace a Workspace owner. Every Workspace Owner still signs
in and grants Google consent explicitly. The resulting Google Refresh Token, consent record,
connection identity, Provider Choice, and Model Choice remain Workspace-local. A token broker,
hosted secret service, cross-Workspace token reuse, and remote multi-user hosting are rejected.

Guided Setup is a local, operator-driven, ten-stage, resumable procedure. It provisions the
installation credentials, guides owner consent, preserves Workspace choices, and verifies the first
result. Settings shows status and stable setup destinations, never secret values or editable
installation credential fields. `/onboarding?goal=meetings` is the goal-addressable path to a first
Meeting Debrief; unrelated product setup remains separate.

Legacy Workspace credentials move only through the explicit backup-gated command
`migrate-installation-credentials.mts check|apply`. Every path is absolute and the operator must
provide an accepted Workspace backup. `check` is read-only. `apply` refuses while the supported
Workspace writer lock is held, verifies exact provider-specific values, atomically writes a
mode-600 destination, and removes only the three superseded Workspace fields after destination
verification. A failure before source removal leaves the source intact; the backup remains the
recovery boundary. The operation is idempotent and never prints a secret. Startup refuses a
Workspace that still has legacy credential fields; it never migrates or strips them implicitly.

The local loopback trust boundary from ADR-0001 remains: the Installation Operator is trusted with
the installation environment, while Workspace owners are trusted only with their own Workspace.
The installation credential is not a Workspace/domain record, and a Drive folder is not a
credential. See `CONTEXT.md` for the ownership vocabulary and `ONBOARDING.md` for the operator
procedure.
