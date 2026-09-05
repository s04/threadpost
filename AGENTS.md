# Working on Threadpost

Threadpost is a standalone, open-source website chat bridge. Keep examples
generic and synthetic. Never copy customer data, private project context,
credentials, deployment details, or another repository's history into it.

Use small changes and preserve conversation isolation, authenticated operator
access, webhook validation and durable delivery state. Do not claim delivery
when a provider request failed or its outcome is unknown. Do not automatically
retry ambiguous external sends. Treat all message text as untrusted text.

Run relevant checks locally before committing or pushing. Hosted CI is manual
only. Record actual checks and limits in the handoff. No outbound messages to
real users or external account changes without explicit authorization.
