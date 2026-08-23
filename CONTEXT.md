# Found42 Chief of Staff

A local application that hosts Found42's meeting and content workflows as tabs in one app. It
replaces Relay, which is being retired; each Relay workflow worth keeping is rebuilt here as a
Module.

## Language

**Shell**:
The application that hosts Modules — navigation and Home, settings, the Google connection, and the
machinery that runs and records work.
_Avoid_: Host app, platform, framework

**Home**:
The Shell's front door — the surface the app opens on, stating where the workspace stands and
linking into the Modules. Not a Module: it has no workflow of its own.
_Avoid_: Dashboard, landing page

**Module**:
One workflow. A Module contributes what is specific to its workflow and relies on the Shell for
everything generic. It is **planned** until its Runs, Intakes and Output Adapters exist and
**live** once they do; independently of that, it either has something for a person to look at,
and is presented as a tab, or it is **headless**. A planned Module is announced on Home and
holds no tab.
_Avoid_: Plugin, tab, feature, workflow (reserve "workflow" for the Relay original)

**Headless Module**:
A live Module with nothing for a person to look at. It holds no tab, and its only presence is
its Runs in Home's recent activity. Headless is not a stage of building: a headless Module is
finished.
_Avoid_: Background Module, planned Module (a planned Module is unbuilt; a headless one works)

**Hot Take**:
A planned Module that turns a link or transcript into a draft LinkedIn post. Its Runs, Intakes, and Output Adapters are not yet implemented.
_Status_: planned

**Run**:
One scope of work owned by one Module, with a status and an append-only event log. Its result is
the Module's own shape, and it may wait rather than reach an end.
_Avoid_: Job, task (a Task is a Google Task), execution

**Stage**:
A named span of a Run that the Module opens and the Shell records. What a partial failure inside a
Stage means is the Module's to decide.
_Avoid_: Step, phase, status

**Cross-Run index**:
A read-only view over every Run's result — for example, every extracted Task with the Run it came
from. Derived on read; nothing writes to it.
_Avoid_: Table, store, database

**Intake**:
The part of a Module that finds work to do. It starts zero, one or many Runs, and the Module
decides how many.
_Avoid_: Trigger, source, input, signal

**Output Adapter**:
The part of a Module that writes outward, into a system the app does not own. A Google Output
Adapter is obtained from the Google connection or not at all.
_Avoid_: Sink, writer, integration

**Google connection**:
The Shell's authorization to act on one person's Google account. Each person registers their own
OAuth client, so the connection is either unconfigured, disconnected, connected, or expired —
expiry being a weekly event rather than a fault. It is the only route to a Google surface
(Tasks, Gmail, Drive) and the only holder of client credentials and refresh tokens; a Module's
Intake or Output Adapter reaches Google with credentials from the connection or not at all.
_Avoid_: Google auth, login, OAuth (the protocol is not the connection)

**Workspace**:
The directory holding all state — configuration, secrets, and every Run. There is no database.
_Avoid_: Data dir, store

**Relay**:
The third-party workflow tool Found42 is migrating off. Its export is the source list of
candidate Modules.
_Avoid_: relay.app, the automation tool

**Relay execution**:
One past run of a Relay Workflow, as recorded in Relay's export. Not a Run — a Run belongs to a
Module in this app.
_Avoid_: Relay run, run (a Run is this app's)

**EdgeScale cube**:
The 3U on-premise server (Intel CPU, Nvidia GPU) that will eventually host this app and run
local models. Not yet accessible.
_Avoid_: Edgecale, edge scale, the box, the cube (alone)
