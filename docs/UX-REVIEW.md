# Interface design notes

These notes preserve the useful design decisions from the 0.2 review (4 October 2026). The original three-tab layout and same-tab save recovery were superseded by 0.3. Use [STATUS.md](STATUS.md) and the [current release notes](RELEASE-0.4-PREVIEW.md) for current behaviour.

## Problems behind the design

| Problem | Design direction |
|---|---|
| Setup controls displaced everyday work on a phone | Compact header and household switcher; a clear setup action for new users |
| Navigation appeared after page content | Persistent, labelled bottom navigation |
| Technical terms obscured household spending versus trips | Use household/trip labels and distinct creation flows |
| Zero balances and missing records looked like loading failures | Distinct loading, empty and error states |
| Positive/negative balance signs were unclear | Say “You owe”, “You are owed” and “You’re even” |
| Expense entry showed too much at once | Put amount, description, payer and beneficiaries first; collapse secondary fields |
| Custom splits were difficult to check | Explicit member selection, per-person amounts and a final review |
| A lost response could encourage duplicate expense entry | Retain the exact request and provide a recovery action |
| Background refresh could disrupt an unfinished form | Preserve drafts and report list/form failures separately |

## Continuing principles

Keep the common phone tasks easy to reach. Show what a transaction means to the person using the app, and make uncertain save outcomes explicit. Preserve the user's work through navigation and reconnects, while letting the database enforce amounts and access rules.

Automated layouts and accessibility scans help catch regressions. They do not replace checking keyboard entry, enlarged text, screen readers and installed Home Screen use on actual devices.
