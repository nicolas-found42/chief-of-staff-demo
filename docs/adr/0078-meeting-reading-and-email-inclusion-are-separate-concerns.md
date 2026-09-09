# Meeting pages are complete reading surfaces; email inclusion is independent

Meeting Wizard keeps one durable Meeting page with separate Brief and Debrief
tabs, but each tab becomes the complete reading surface. Individual Action Items
are reviewed there through the existing canonical Tasks behavior, rather than
through a second extraction-specific review list. This follows ADR-0077's overview
and History without merging the workflows or their ownership, as specified in
[issue #327](https://github.com/nicolas-found42/chief-of-staff-demo/issues/327).

Creating a Gmail draft is an optional flow. Whether a commitment appears in that
email is an explicit choice separate from promoting or dismissing its Action
Item: dismissal can mean incorrect work, completed work, or work the owner does
not want to track. Using that one decision as permanent authority over email
content would conflate those meanings. Defaults may reflect canonical review
state, but changing email inclusion never changes a Task or Action Item.

The preview and final output share one server-owned composer. Creation is bound
to the reviewed content, selected commitments, and recipients; changed inputs
require an updated preview rather than silently creating different content. Email
wording comes from the Meeting's extracted proposals, not subsequent Task edits.
Earlier proposals remain identifiable and explicitly selectable. Existing private
field exclusions, verified-recipient policy, draft receipts, and post-creation
content locks remain in force.

This preserves ADR-0037's regeneration-only correction policy, ADR-0050's separate
Meeting workflows, ADR-0052/0053's canonical Task ownership and independent review,
and ADR-0061's non-expiring results. It replaces the legacy extraction drop list
as authority for new email inclusion choices and clarifies that resetting legacy
review arrays during regeneration does not reset canonical Action Item decisions.
Existing Tasks and review decisions survive, and new proposals may be added.

These are accepted decisions for future implementation under #327. The spec uses
fully automated browser, accessibility, layout, and interaction-budget evaluation;
it requires no human study and does not label machine timings as human learning
measurements.
