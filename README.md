# Signal

**A request triage dashboard for account managers in fast-moving startups.**

Signal logs every request coming in from clients and internal teams, then automatically ranks them using a weighted model covering who asked, effort, revenue impact, deadline and account health. It always surfaces the single highest-priority task, builds a realistic daily plan, flags overdue client replies and stalled requests, and keeps a running record of delivered work ready for QBRs and reviews.

Built with fintech account management in mind: capital markets firms, banks and the internal teams that serve them.

## Features

- **Ranked queue.** Every request gets a priority score out of 10 and is shown in an aligned table: who asked, value (revenue generating or retention), deadline, effort and account details.
- **"Do this next" panel.** The highest-priority request always sits at the top with its full context.
- **Account intelligence.** Each client has ARR, a renewal date and a health score (0 to 100). Key accounts, upcoming renewals and at-risk accounts rank higher automatically.
- **Reply tracking.** Client requests not acknowledged within the reply window are flagged until marked as replied.
- **Waiting on someone.** Blocked requests leave the ranking and return automatically on their follow-up date.
- **Today's plan.** Fits the highest-priority work into your daily focus hours and warns when you're over capacity.
- **Learning loop.** Tracks when you work out of rank order and suggests scoring changes.
- **Configurable scoring.** Focus hours, reply window, key-account threshold, renewal window and factor weights are all adjustable in Settings.

## How the scoring works

| Factor | What it measures | Points |
| --- | --- | --- |
| Who asked | Unhappy client or senior leadership 2, happy client 1, colleague 0 | 0 to 2 |
| Effort | Quick 1, moderate 2, complex 3 (can be flipped to favour quick wins) | 1 to 3 |
| Value | Revenue generating or retention 3, leadership 2, colleague 1 | 1 to 3 |
| Deadline | Client requests always 3; internal: today 3, this week 2, later 1 | 1 to 3 |
| Account | +1 key or renewing account, +1 at-risk health score (under 50) | 0 to 2 |

Points are multiplied by each factor's weight and scaled to a score out of 10. Deadlines re-score automatically as they get closer.

## Getting started

No installation or build step is needed.

1. Download or clone this repository.
2. Open `index.html` in any modern browser.
3. Click **Add 3 examples** to see it in action, or add your own clients and requests.

To use it online, enable **GitHub Pages** in the repository settings (Settings, Pages, deploy from the `main` branch, root folder).

## Data and AI features

- **Standalone version (this repository):** everything you add is saved in your own browser's local storage. Nothing is sent anywhere. Clearing your browser data, or switching browser or device, starts you with an empty queue.
- **Claude version:** the original version runs as a Claude artifact, where data is saved to your Claude account and three AI features are available: reading a pasted email or Slack message into a request, writing manager updates, and summarising client accounts. These features rely on Claude's artifact runtime and are automatically hidden in the standalone version.

## Project structure

```
signal/
├── index.html              Page layout and dialogs
├── assets/
│   ├── css/styles.css      Design tokens, light and dark themes, layout
│   └── js/app.js           Scoring model, storage, rendering and interactions
├── docs/
│   └── onboarding-playbook.md
├── LICENSE
└── README.md
```

## Tech

Plain HTML, CSS and JavaScript with no frameworks or dependencies. Fonts: Bricolage Grotesque and Figtree via Google Fonts. Supports light and dark mode, keyboard navigation and reduced motion.

## Roadmap

- Auto-capture requests from email and Slack
- Team view across a whole account management team
- CRM sync (HubSpot, Salesforce) for ARR, renewal and health data
- Response-time reporting
- Shared account history for handovers

## Author

Shanelle El-Nawar
