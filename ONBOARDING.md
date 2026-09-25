# Set up Chief of Staff

This guide takes a local installation from zero to a first Meeting Debrief. The **Installation
Operator** provisions shared credentials once; each **Workspace Owner** performs their own Google
consent and chooses Workspace-owned settings. The flow is local, resumable, and does not upload a
transcript into the app.

The guided procedure is the source of truth:

```bash
./scripts/setup-wizard.sh
```

It has ten stages, can be stopped and resumed, and never edits installation secrets in a Workspace.
The app itself shows only **Configured**, **Missing**, and **Not required** for installation
credentials.

## Before you begin

You need Docker Desktop, pnpm, Python 3, curl, jq, a Google account for each Workspace owner, and
a provider account if you use a cloud model. Ollama needs no provider key. The operator must be
able to keep a private `workspace/` directory and a private installation `.env` (mode `600`). Never
commit `.env` or a Workspace backup.

## The ten Guided Setup stages

1. **Preflight and paths** — confirm the repository, Workspace, and installation environment paths.
2. **Required Workspace backup** — when legacy Workspace credential fields need transfer, stop the
   app and all writers, then capture and verify a private backup. A fresh Workspace and a resumed
   setup after transfer do not repeat this step.
3. **Check migration and confirm** — when legacy fields remain, run the backup-gated read-only
   credential check. No source or destination changes occur at this stage.
4. **Installation Google client** — provision one Google OAuth client for the installation and
   store its ID and secret in the process environment or `.env`.
5. **Installation provider key** — provision one provider-specific key
   (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY`), or select
   Ollama and provide no key.
6. **Apply migration and verify destination** — with the app stopped and its Workspace writer lock
   released, apply the checked migration, verify exact values and mode `600`, and remove only the
   three superseded Workspace fields. The backup remains available.
7. **Restart installation** — recreate/start the app and verify `/api/config.installation` reports
   status only.
8. **Owner Google consent** — each Workspace owner opens Settings, signs in with their own Google
   account, and grants the requested permissions. Refresh tokens and connection identity remain in
   that Workspace.
9. **Provider, model, and Transcript Intake** — choose an installed provider or Ollama, choose a
   model, pick the transcript Drive folder, enable Drive polling, and explicitly allow the app to
   read and process that folder. These are five independent facts.
10. **Verify the first result** — open Meeting Wizard and follow its truthful Transcript Intake
    status until a Debrief is ready.

You can leave at any point. Re-run the wizard with the same private paths; it reuses an accepted
backup and existing installation values, and checks the owner consent and Meeting prerequisites
again. Existing secrets are kept without re-entry. Stage 10 reports a waiting state until a
Debrief is ready, or an unavailable state if the app cannot verify it; rerun the wizard to verify
the first result. An absolute `WORKSPACE_DIR` override
uses a separate Compose project and loopback ports (44317/44318 by default) so it cannot replace
the normal Workspace's running container. If you use Google consent in that isolated project,
register its `http://localhost:44317/api/google/callback` redirect URI with the installation OAuth
client as well. The override keeps its installation environment in a sibling
`<WORKSPACE_DIR>.installation.env` file and uses a separate private backup destination by default.

## Credential custody

The installation operator is trusted to provision the shared Google OAuth client and model key.
Those values are available to every Workspace in the local installation, but they are not
Workspace records. The Workspace retains:

- provider choice and per-purpose model choices;
- the Google refresh token, consent record, and connection identity; and
- the selected Drive folder, intake settings, and all product records.

A Workspace owner must still authenticate and consent explicitly. A refresh token is never copied
between Workspaces, and the app has no hosted token broker or secret service.

## First Meeting Debrief

Meeting setup is goal-addressable at `/onboarding?goal=meetings`. It contains exactly these five
required steps:

1. Configure the model extraction provider.
2. Connect Google.
3. Choose the transcript Drive folder.
4. Enable Drive polling.
5. Allow the app to read and process the selected folder.

Other product setup (Brand Voice, Internal Domains, YouTube destinations, workflow bundles, and
Owner Profile) remains available separately and does not make the Meeting goal unusable. The
Meeting Wizard shows a content-free readiness projection and links to the first unmet owning
control. It never calls a missing transcript an upload and never implies a manual upload exists.

## Running and stopping

From the repository directory:

```bash
docker compose up -d
# or, for the first build:
docker compose up -d --build
docker compose down
```

The app is published on `http://127.0.0.1:4317`. Do not expose the port beyond loopback. The
operator-provided `.env` is read for installation credentials; a Workspace `config.json` is not a
credential store.

## Troubleshooting

| Symptom | What to do |
|---|---|
| Setup wizard cannot verify a backup | Stop the app and rerun the required backup. If the Workspace changed after capture, choose a new private backup destination; never edit the old backup. |
| Installation status is Missing | Run the wizard's installation stages or provide the corresponding process environment variable. Do not paste it into Settings. |
| Google is not configured | The installation client is missing. Run Guided Setup; the owner consent step is separate. |
| Google consent needs renewal | Reconnect from Settings. The installation client is shared, but the Workspace consent is not. |
| Drive polling is off | Enable Drive polling; a selected folder alone does not imply active intake. |
| Transcript Intake is waiting | Put the transcript in the selected Google Drive folder and use **Sync now**. There is no in-app upload path. |
| A model call fails | Check the selected provider/model and the installation status; the app never silently falls back to another provider. |
| A backup or migration fails | Keep the private backup, do not edit either side by hand, and resume through the wizard. |

For deeper operational preservation and restoration, read
[`docs/agents/workspace-backup.md`](docs/agents/workspace-backup.md).
