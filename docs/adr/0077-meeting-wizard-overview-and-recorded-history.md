# Meeting Wizard leads with Meetings and retained history

Meeting Wizard presents Today, Recent meetings, Upcoming, and contextual review,
with route-backed Today, This week, and History navigation. A read-only composition
over durable Meetings, persisted workflow artifacts, and canonical Action Items
supplies bounded rows and source-scoped counts. History searches and paginates at
this shared read boundary; it describes the earliest retained Meeting as the
beginning of recorded history, without claiming complete Google Calendar coverage.

The five large metric cards and today-only landing list hid completed conversations
behind an unrelated Workspace backlog. This decision replaces those presentation
requirements from issues #193 and #151, as specified in [issue #325](https://github.com/nicolas-found42/chief-of-staff-demo/issues/325).
Brief and Debrief availability remain separate, and a failed later attempt does not
hide an earlier successful artifact. Passive overview and History reads neither
generate artifacts nor deliver messages. Retry actions use the owning workflow's
existing contract and state their owner-delivery consequence when applicable.

ADR-0050's durable Meeting remains the stable destination, with distinct Brief and
Debrief tabs whose selection can be linked and restored through browser navigation.
ADR-0060's Weekly Briefing contract is unchanged. Tasks owns proposal review and
accepted Tasks; contextual links filter that existing review surface by source
Meeting. Historical proposals retain their original dates and evidence, and remain
pending until an explicit policy or review transition, preserving ADR-0061. No
second writable projection or combined workflow is introduced.
