# Found42 Chief of Staff

A local application that hosts Found42's meeting and content workflows as tabs in one app. It
replaces Relay, which is being retired; each Relay workflow worth keeping is rebuilt here as a
Module.

## Language

**Shell**:
The application that hosts Modules — navigation, settings, Google connection, and the machinery
that runs and records work.
_Avoid_: Host app, platform, framework

**Module**:
One workflow, presented as a tab. A Module contributes what is specific to its workflow and
relies on the Shell for everything generic.
_Avoid_: Plugin, tab, feature, workflow (reserve "workflow" for the Relay original)

**Hot Take**:
A planned Module that turns a link or transcript into a draft LinkedIn post. Its Runs, Intakes, and Output Adapters are not yet implemented.
_Status_: planned

**Run**:
One execution of one Module, with a status, a persisted result, and an append-only event log.
_Avoid_: Job, task (a Task is a Google Task), execution

**Stage**:
A named part of a Run, chosen by the Module. A Stage either finishes or fails, and a failed Run is
retried from the Stage that failed.
_Avoid_: Step, phase, status

**Cross-Run index**:
A read-only view over every Run's result — for example, every extracted Task with the Run it came
from. Derived on read; nothing writes to it.
_Avoid_: Table, store, database

**Intake**:
The thing that starts a Run — an upload, a poll of an external service, a watched folder, a
schedule.
_Avoid_: Trigger, source, input

**Output Adapter**:
The step that writes a Run's result into a system outside the app: a Google Task, a Gmail draft,
a Doc.
_Avoid_: Sink, writer, integration

**Workspace**:
The directory holding all state — configuration, secrets, and every Run. There is no database.
_Avoid_: Data dir, store

**Relay**:
The third-party workflow tool Found42 is migrating off. Its export is the source list of
candidate Modules.
_Avoid_: relay.app, the automation tool

**EdgeScale cube**:
The 3U on-premise server (Intel CPU, Nvidia GPU) that will eventually host this app and run
local models. Not yet accessible.
_Avoid_: Edgecale, edge scale, the box, the cube (alone)
