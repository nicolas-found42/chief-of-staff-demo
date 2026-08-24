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
A live Module with nothing for a person to look at. It holds no tab, and its Runs are read in
the Runs list. Headless is not a stage of building: a headless Module is finished.
_Status_: no instance. YouTube Trends was the worked example and turned out to hold a tab
(ADR-0025); the term stays because the category is real and the next Module may land in it.
_Avoid_: Background Module, planned Module (a planned Module is unbuilt; a headless one works)

**Hot Take**:
A planned Module that turns a link or transcript into a draft LinkedIn post. Its Runs, Intakes, and Output Adapters are not yet implemented.
_Status_: planned

**YouTube Trends**:
A live Module that watches whole YouTube channels and records a daily trend. Once a day it
enumerates every video on each channel it tracks, reads its view count, and records the day;
its tab shows one sub-tab per channel, and its spreadsheet keeps the same numbers outside the
app. Named for what it produces, as Hot Take is — the Relay original it replaces keeps its own
name, Weekly YouTube View Count.
_Status_: live
_Avoid_: YouTube Module, Weekly YouTube View Count (that is the Relay original). "YouTube
view counts" names the Google surface (ADR-0016), never this Module.

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
from, or a channel's view counts over time. Derived on read; nothing writes to it. It may be
cached, provided one thing invalidates it and that thing is the only writer.
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
(Tasks, Gmail, Drive, YouTube, Sheets) and the only holder of client credentials and refresh
tokens; a Module's Intake or Output Adapter reaches Google with credentials from the connection
or not at all.
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

**Idea Engine**:
A live Module that reads a meeting transcript from the Transcripts Drive folder and extracts
Content Ideas attributed to the workspace owner. One Intake file creates one Run; that Run
makes 12 Stages (one per content type) in batches of 4, writes the ideas to the Google Sheet
`All RA Content Ideas` via an Output Adapter, creates a Gmail draft digest, and posts a Home
notification. Its tab shows a Cross-Run index over all Runs, primary by transcript file,
filterable by content type.
_Status_: live (spec #31 binding, 2026-08-24)
_Avoid_: Idea Generator, Ideas Module

**Content Idea**:
One idea extracted from a transcript, attributed to the workspace owner with evidence (time
stamp + verbatim quote, confidence ≥0.9). Carries Title, Description, Target Audience, CTA,
Format (4 Sheet values: articles, blog_posts, videos, how_to_guides), ContentType (12 prompt
types: e.g., Short/long video, article), and Expand Prompt (the prompt a downstream copywriter
uses to turn the Title into a draft). Evidence and confidence live in the Run result, not in
the Sheet.
_Avoid_: idea (alone), generic idea

**Expand Prompt**:
The prompt text a downstream copywriter uses to expand a Content Idea into a draft. Formerly
called Custom Prompt in Relay. Part of a Content Idea; not a Module-level prompt.
_Avoid_: Custom Prompt, custom prompt

**Evidence**:
The time stamp and verbatim quote that prove a Content Idea was said by the workspace owner,
plus a confidence score. Stored in the Run result for audit; not written to the Sheet.
