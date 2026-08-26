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

**Content Scout**:
A live Module that monitors recurring sources for timely, brand-aligned subjects, presents a
shortlist for a person to select from, and creates a Content Pack for each selection.
_Status_: live
_Avoid_: Hot Take, Daily Hot Take, Daily Content Scout, Daily Post Scout

**Brand Profile**:
The workspace owner's editable local description of the company, including its positioning,
audiences, offers, differentiators, proof, tone, vocabulary, and content constraints. Initially
generated from a bounded crawl of the company's website; thereafter owned by the person, not the
website. Its canonical representation is versioned local Markdown. A rescan proposes a three-way
diff against the previous website baseline and the person's current revision, never an overwrite.
_Avoid_: Brand document, Brand Guide, Brand Brief

**Source Target**:
A recurring account, channel, community, search, feed, website, or site section that Content Scout
monitors for source material. A person may configure one directly or accept one that Content Scout
suggests from the Brand Profile and existing Source Targets. Archiving one stops future monitoring
but preserves its evidence and history and prevents automatic re-suggestion until a person restores
it.
_Avoid_: Individual post, source link, target (alone)

**Source Target Backfill**:
A person-requested, bounded historical collection for one active Source Target — 7, 30, or 90 days —
run independently of the daily schedule. A Source Adapter must declare which windows it can honor
with a genuine historical `since`; a window it does not declare fails as unsupported rather than
completing as an empty success. It never changes the Source Target's Daily Intake checkpoint or
48-hour overlap.
_Avoid_: Historical scan, deep scrape, backscan

**Source Suggestion**:
A proposed Source Target found during a weekly or manually started Source Discovery Run. It records
why it was suggested, the supporting URLs, and its relationship to the Brand Profile or approved
Source Targets. It is never monitored on schedule until a person approves it; dismissed suggestions
remain local and may later be restored.
_Avoid_: Discovered source (it has not become a Source Target), recommendation (alone)

**Source Adapter**:
One platform- or protocol-specific collector behind Content Scout's shared source-item contract. Its
state is Available, Experimental, or Coming later, and its diagnostics distinguish unavailable data
from a failed retrieval. A platform is not a Source Adapter and one adapter's failure does not stop
the others from running.
_Avoid_: Scraper (too narrow), connector (reserved for authenticated service connections)

**Source Item**:
One normalized piece of public source material retrieved from a Source Target, with its canonical
URL, platform identity, author, publication time, extracted content, evidence, and field-level
completeness. It is untrusted third-party evidence, never an instruction to the Module. A Source
Item may support a Content Opportunity but is not itself an opportunity.
_Avoid_: Source (ambiguous with Source Target), content (too broad), post (not every item is a post)

**Opportunity Brief**:
The immutable input shared by all independent Content Draft generations for one selected Content
Opportunity. It contains the opportunity, strongest supporting Source Items, bounded enrichment,
claim evidence, Brand Profile revision and snapshot, and no sibling Content Drafts.
_Avoid_: Prompt, context (alone), research bundle

**Source Discovery Run**:
A weekly or manually started Content Scout Run that uses the Brand Profile, approved Source Targets,
public search, related or recommended accounts, citations, mentions, and outbound links to produce
Source Suggestions. It finishes without waiting for approval; suggestion decisions live in the
Module's persistent source view.
_Avoid_: Discovery scan, source crawl

**Content Opportunity**:
One timely, brand-aligned subject that Content Scout may recommend, supported by one or more items
found across Source Targets. It carries a proposed angle, urgency, evidence, and supporting source
URLs; it is not drafted content.
_Avoid_: Hot take, candidate (alone), topic (alone)

**Content Pack**:
The complete set of Content Drafts that Content Scout creates independently from one selected
subject. Every supported publication channel and draft format is represented, and every draft has
been published to its own Notion page. Successful local drafts survive a partial generation or
publication failure and retries create only missing work.
_Avoid_: Draft bundle, content bundle

**Content Draft**:
One copy-ready output in a Content Pack, intended for one publication channel and draft format. It
uses the selected subject and Brand Profile as context, never another Content Draft. The local Run
artifact is immutable; its Notion copy is the person's editable working version.
_Avoid_: Artifact (a Run artifact is any file owned by a Run), post (not every Content Draft is a
post)

**Draft Target**:
One versioned publication-channel and draft-format contract represented in every Content Pack.
Content Scout currently plans 23 Draft Targets; changing that set changes the Content Pack contract.
_Avoid_: Template, format (alone), channel (alone)

**YouTube Trends**:
A live Module that watches whole YouTube channels and records a daily trend. Once a day it
enumerates every video on each channel it tracks, reads its view count, and records the day;
its tab shows one sub-tab per channel, and its spreadsheet keeps the same numbers outside the
app. The Relay original it replaces keeps its own name, Weekly YouTube View Count.
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

**Result Shape**:
The set of fields one call to a model must come back with. It belongs to the Module making the
call, never to the Shell: one seam serves every Module, so a Module that does not name its own
result shape is handed another Module's.
_Avoid_: Schema (alone), extraction shape, output format

**Result Shape Binding**:
How a model is made to answer in a Result Shape. Three of them, ordered by how deterministic they
are: the provider constrains decoding to the shape, or it constrains the arguments of a call the
model is required to make, or the shape is merely asked for in the prompt. A model gets the most
deterministic binding it declares support for, and a weaker one only where support is unknown.
_Avoid_: Structured output (names one binding, not the choice), response format, JSON mode

**Model-boundary failure**:
What a failed call to a model is, at the Shell's one LLM seam. It carries classified facts rather
than a sentence — which provider and model were called, which upstream answered, why the model
stopped, the body's byte length, which fields of the answer arrived populated or empty, and the
top-level keys that came back — under one of eight stable classifications. Callers decide
retryability and wording from those facts, never by matching the message. It records shape only:
transcripts are private and Source Items are untrusted evidence, so no field of it holds payload
text.
_Avoid_: LLM error, provider error, extraction error (that is the Run event, not the failure)

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
