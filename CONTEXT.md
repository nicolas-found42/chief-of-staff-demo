# Found42 Chief of Staff

A local application that hosts Found42's meeting and content workflows as four product areas in
one app. It replaces Relay, which is being retired; each Relay workflow worth keeping is rebuilt
here as a Module.

## Language

**Shell**:
The application that hosts Modules — navigation and Home, settings, the Google connection, and the
machinery that runs and records work.
_Avoid_: Host app, platform, framework

**Home**:
The Shell's front door — the surface the app opens on, stating where the workspace stands and
linking into the product areas. Not a Module: it has no workflow of its own.
_Avoid_: Dashboard, landing page

**Product area**:
One of the four things the app is for — Content Engine, Content Research, Person Profiles, Meeting
Wizard. A product area names ownership, not backend registration: it may present one Module, two
(Meeting Wizard), or a Workspace resource that is no Module at all (Person Profiles). The four are
an explicit list the header nav and Home's cards both render, never derived from the Module
registry (ADR-0043), so a Module can be added, retired or re-parented without the app appearing to
gain or lose a product.
_Avoid_: Tab, section, module (a product area is not one)

**Module**:
One workflow. A Module contributes what is specific to its workflow and relies on the Shell for
everything generic. It is **planned** until its Runs, Intakes and Output Adapters exist and
**live** once they do; independently of that, it either has something for a person to look at,
reached inside the product area that presents it, or it is **headless**. No Module holds a
navigation entry of its own: navigation is the four product areas (ADR-0043).
_Avoid_: Plugin, tab, feature, workflow (reserve "workflow" for the Relay original)

**Headless Module**:
A live Module with nothing for a person to look at. It has no surface of its own, and its Runs are
read in the Runs list. Headless is not a stage of building: a headless Module is finished.
_Status_: no instance. YouTube Trends was the worked example and turned out to have something to
look at (ADR-0025); the term stays because the category is real and the next Module may land in it.
_Avoid_: Background Module, planned Module (a planned Module is unbuilt; a headless one works)

**Content Scout**:
A live Module that monitors recurring sources for timely, brand-aligned subjects, presents a
shortlist for a person to select from, and creates a Content Pack for each selection.
_Status_: live; its Content Pack output is retired by ADR-0043 at the consolidation cutover
_Avoid_: Hot Take, Daily Hot Take, Daily Content Scout, Daily Post Scout

**Content Engine**:
The product area in which an Authorized Author turns one evidence-backed subject into independent
Platform Outlines and optional Content Engine Drafts for selected publication targets.
_Status_: planned (ADR-0043)
_Avoid_: Content Studio, Content Generator, Content Scout (that remains the opportunity-discovery Module)

**Content Project**:
One durable scope of Content Engine work, carrying its subject, Authorized Author, input revisions,
approved Outline Briefs, Platform Outlines and optional Content Engine Drafts.
_Avoid_: Idea, campaign, Content Pack

**Research Request**:
One finite piece of fresh public research owned by a single Content Project revision: an explicit
scope, an explicitly configured provider bundle, per-provider query and evidence limits, and one
diagnostic per provider. Every provider is asked once and the request ends, so it reuses the shared
Source Item contract without acquiring a Run, checkpoint, baseline, schedule or Named Person watch.
Its public person queries may carry any identifier the Workspace holds, email included, and record
the identifier class, provider, timestamp and purpose rather than the identifier value. An
explicitly selected all-provider bundle reports incomplete until every provider in it succeeds.
_Avoid_: Research Run, scan, enrichment (that is Person Profiles' word), Content Research

**Authorized Author**:
The workspace owner or a confirmed Person Profile that Workspace policy permits Content Engine to
represent as the authorial point of view.
_Avoid_: Subject, Person Profile (not every Profile may author content), voice

**Content Voice**:
The manually approved author-specific writing guidance that Content Engine combines with the Brand
Profile; it is consumer policy rather than Person Evidence.
_Avoid_: Person Profile voice, inferred voice, style clone

**Outline Brief**:
The immutable approved input shared by all independent Platform Outline generations in one Content
Project revision, including intent, evidence and the exact Brand Profile revision.
_Avoid_: Opportunity Brief, prompt, research bundle

**Platform Outline**:
One versioned publication-target plan generated from an Outline Brief, containing structure,
evidence placement and target constraints but not complete publishable copy.
_Avoid_: Content Draft, post, template

**Content Engine Draft**:
One optional immutable copy-ready or record-ready output generated from an approved Platform
Outline for one target at a time.
_Avoid_: Content Draft (that belongs to a Content Pack), publication, post

**Brand Profile**:
The workspace owner's editable local description of the company, including its positioning,
audiences, offers, differentiators, proof, tone, vocabulary, and content constraints. Initially
generated from a bounded crawl of the company's website; thereafter owned by the person, not the
website. Its canonical representation is versioned local Markdown. A rescan proposes a three-way
diff against the previous website baseline and the person's current revision, never an overwrite.
Every accepted revision is retained; restoring one appends it as a new current revision rather
than rewinding history.
Content Engine presents this resource under the user-facing label **Brand Voice**.
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
One platform- or protocol-specific collector behind the Workspace's shared Source Item contract. Its
state is Available, Experimental, or Coming later, and its diagnostics distinguish unavailable data
from a failed retrieval. A platform is not a Source Adapter and one adapter's failure does not stop
the others from running.
_Avoid_: Scraper (too narrow), connector (reserved for authenticated service connections)

**Search Provider**:
One independent keyless public-search source behind the PublicSearch seam. It answers a query
with normalized public results or refuses; one provider's refusal narrows the merged results
and never fails the query, and only every provider refusing is a failed search (ADR-0049). Its
health is visible in the seam's diagnostics, never in the shape of a result.
_Avoid_: Search engine (some providers are registries, archives or indexes), source (that is a
Source Target's word), scraper (the posture is keyless APIs and feeds first)

**Source Item**:
One normalized piece of public source material retrieved from a Source Target, with its canonical
URL, platform identity, author, publication time, extracted content, evidence, and field-level
completeness. It is untrusted third-party evidence, never an instruction to the Module. A Source
Item may support a Content Opportunity but is not itself an opportunity.
_Avoid_: Source (ambiguous with Source Target), content (too broad), post (not every item is a post)

**Opportunity Brief**:
The immutable input shared by all independent Content Draft generations for one selected Content
Opportunity. It contains one to eight of the strongest supporting Source Items, states their count,
and carries bounded enrichment, claim evidence, the Brand Profile revision and snapshot, and no
sibling Content Drafts.
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
_Status_: retired at the consolidation cutover (ADR-0043)
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
its page shows one sub-tab per channel, and its spreadsheet keeps the same numbers outside
the app. The Relay original it replaces keeps its own name, Weekly YouTube View Count.
_Status_: live, presented under Content Research at `/content-research/trends` (ADR-0044);
it keeps its own Module identity, Runs, checkpoints, retry receipts and spreadsheet output
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
(Tasks, Calendar, Gmail, Drive, YouTube, Sheets) and the only holder of client credentials and refresh
tokens; a Module's Intake or Output Adapter reaches Google with credentials from the connection
or not at all.
_Avoid_: Google auth, login, OAuth (the protocol is not the connection)

**Workspace**:
The directory holding all state — configuration, secrets, and every Run. There is no database.
_Avoid_: Data dir, store

**Generated data**:
The half of the Workspace the products produced — every Run, Person Profile, processed Transcript,
Brand Profile, Content Research record and Content Project, plus the checkpoints tracking what was
already ingested or scheduled. Not "everything in the Workspace": credentials, pointers and
settings are the other half, and the line between them is one explicit table both the one-time
migration reset and the repeatable clear read (ADR-0046, ADR-0048).
_Avoid_: Workspace data, user data, app data (each reads as "everything", which is the misreading
that would delete credentials)

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
A Module that reads a meeting transcript from the Transcripts Drive folder and extracts
Content Ideas attributed to the workspace owner. One Intake file creates one Run; that Run
makes 12 Stages (one per content type) in batches of 4, writes the ideas to the Google Sheet
`All RA Content Ideas` via an Output Adapter, creates a Gmail draft digest, and posts a Home
notification. Its tab shows a Cross-Run index over all Runs, primary by transcript file,
filterable by content type.
_Status_: retired by issue #142 (ADR-0045); the Transcript Catalog and Meeting Debrief supersede it for private transcripts
_Avoid_: Idea Generator, Ideas Module

**Meeting Brief Generator**:
A live Module that prepares a concise briefing for an upcoming meeting with external guests.
Its live product includes relationship history, company records, public intelligence, relevant
workspace material, and Person Profiles rather than treating any one enrichment class as a later
enhancement.
_Status_: live
_Avoid_: Meeting Briefing Generator (the Relay original), Briefing Module

**Person Profile**:
A durable, reusable, evidence-backed record of one person, resolved from Identity Signals and
composed of sourced Person Evidence. It is owned by the Workspace rather than by the workflow that
first requested it, so meeting preparation, content research, and future outreach may reuse the same
identity without silently sharing guesses.
_Avoid_: Guest Profile, guest dossier, contact profile (the person need not be a contact)

**Identity Signal**:
An email address, full name, social handle, profile URL, employer clue, or other observed identifier
used to resolve evidence to one Person Profile. A signal is an input to matching, not proof that two
records identify the same person.
_Avoid_: Identity, lookup key, match (a match is a conclusion)

**Person Evidence**:
A sourced claim, profile reference, publication, activity, or mention attributed to a Person Profile
with its provenance and match confidence. Ambiguous evidence remains visible but cannot establish a
person, employer, or owned publishing surface as fact.
_Avoid_: Profile data, intelligence (alone), fact (unless the evidence establishes it)

**Transcript Catalog**:
The Workspace-owned collection of immutable Transcripts, source and meeting metadata, extracted
mentions, match candidates, review decisions and deletion state shared by meeting consumers.
_Status_: planned (ADR-0043)
_Avoid_: Transcript store, Drive folder, Debrief intake

**Transcript Mention**:
One preserved transcript span classified as a possible person or other entity; it is evidence that
a string occurred in context, not proof of canonical identity.
_Avoid_: Person, Profile match, extracted contact

**Organization Mention**:
One preserved transcript span and normalized identifiers that may refer to an organization without
creating a canonical Organization Profile.
_Avoid_: Organization Profile, employer fact, company record

**Identity Decision**:
The durable reviewed or policy-made conclusion that a Transcript Mention refers to one Person
Profile, is not a person, or remains unresolved.
_Avoid_: Match score, candidate, guess

**Meeting Wizard**:
The product area that presents Calendar occurrences, Meeting Briefs, Transcripts and Meeting
Debriefs together while their prospective and retrospective Runs remain separate.
_Status_: planned (ADR-0043)
_Avoid_: Meeting Module, combined meeting workflow, Meeting Brief Generator

**Meeting Brief**:
The structured result one Meeting Brief Generator Run prepares for an Eligible Meeting. It combines
evidence-backed guest and company context with concise conversation starters, source references and
explicit uncertainty; every Output Adapter renders this same result.
_Avoid_: Briefing, prep brief, email body

**Executive Assistant**:
The Module that reads a mined transcript from the Transcript Catalog and produces a Meeting Debrief
for the workspace owner. It is named for the role it plays rather than for the one artifact it
produces today, so further retrospective work can join it without renaming the role: the role names
the Run, and the hosted `meeting-debrief` Module is the artifact host of that Run's Meeting Debrief.
_Status_: retrospective extraction live (issue #139); review wait, expiry, and approval-gated
outward writes planned (ADR-0038)
_Avoid_: Executive Coach (the Relay original's framing, and the voice the model is cast in, not the
Module), Meeting Debrief Generator, Coach Module

**Meeting Debrief**:
The structured result one Executive Assistant Run extracts from a transcript after a meeting: the
firm decisions taken, action items carrying an inferred owner and an optional due date, the
questions left open, a short summary, an effectiveness assessment with the specific evidence behind
it, and coaching advice. The role names the Run; the `meeting-debrief` Module is its artifact host
— it reads the Transcript Catalog's immutable records and review state and holds the Debrief for
the workspace owner's review, and it decides no identity and writes nothing outward itself. Every
Output Adapter renders this same result.
_Avoid_: Meeting Brief (that one is prospective, prepared from Calendar before a meeting; a Meeting
Debrief is retrospective, extracted from a transcript afterwards), debrief email, meeting notes

**Internal Domain**:
An email domain configured as belonging to the workspace owner's organization.
_Avoid_: Company email domain, owner domain

**External Guest**:
A Calendar attendee whose email domain is not one of the Meeting Brief Generator's Internal
Domains. An External Guest with a Consumer Domain remains external and is enriched person-first.
_Avoid_: External attendee, outsider

**Eligible Meeting**:
A timed, non-cancelled Calendar event that the workspace owner has not declined and that includes at
least one other attendee who has not declined; the attendee may be internal or external.
_Avoid_: Qualifying event, trigger event, candidate meeting

**Consumer Domain**:
An email domain belonging to a personal mailbox provider rather than identifying the External
Guest's employer. It is not company evidence.
_Avoid_: Personal email domain, free email provider

**Employer Match**:
The evidence-backed association between an External Guest with a Consumer Domain and their current
employer. One explicit authoritative link establishes it; otherwise a model may propose a candidate,
but two different organizations must each state the same guest-company relationship before the
association is accepted.
_Avoid_: Company guess, inferred company, likely employer

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
_Avoid_: proof (alone), citation (alone)

**Content Research**:
A Module that watches a curated set of Named People wherever they publish and reports what is resonating, why, and with what hook. It owns its Runs; it does not reuse Content Scout's Runs.
_Status_: live (spec #116, 2026-08-30)
_Avoid_: Content Scout, LinkedIn Content Researcher, Post Analyzer

**Named Person**:
A person Content Research is configured to watch. Every watch is backed by a confirmed Person Profile (identified by its `profileId`); the watch's name comes from that Profile's public-safe projection, and optional handle hints (for example Bluesky DID, YouTube channel, HN username) plus Profile-derived sites resolve the Source Targets collected each Run. The set is curated by the workspace owner; creating or reactivating a watch requires selecting or creating and confirming a Profile first. A watch may be **paused**: lifecycle state in which the configuration is kept and nothing is collected, and which is the decision surface archive and privacy deletion require while the watch still points at its Profile. The watch-list decision and the reusable identity record remain different concepts.
_Avoid_: profile, handle (alone), lead

**Person Suggestion**:
A proposed Named Person found during a People Discovery Run. It records why it was suggested, the supporting URLs, and its relationship to the Brand Profile or approved Named People. It is never watched on schedule until a person approves it; dismissed suggestions remain local and may later be restored, and prevent automatic re-suggestion while dismissed.
_Avoid_: Discovered person, recommendation (alone)

**People Discovery Run**:
A weekly or manually started Content Research Run that uses the Brand Profile, approved Named People, and their collected Source Items to propose Person Suggestions from co-mentions, citations, outbound links, and related accounts surfaced by public search. It finishes without waiting for approval; suggestion decisions live in the Module's persistent person view.
_Avoid_: Discovery scan, people crawl

**Resonance Report**:
The structured result one Content Research Run produces for one Named Person: the top timely Source Items attributed to that person, each with its resonance evidence and a hook. It is the Module's primary result; Output Adapters render the same report.
_Avoid_: Briefing (alone), digest (alone), content report

**Resonance Score**:
The per–Source Item measure of how much a piece is resonating, computed as a z-score against the person's 90-day baseline rolled up across platforms, combined with platform-weighted counts. It is an observed signal, not an LLM judgement.
_Avoid_: popularity score, engagement score, virality
