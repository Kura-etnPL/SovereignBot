# GitHub frontend integration — 2026-09-05

Local checkout: `projects/SovereignBot-luna-attention`.
Local base: `6d693bd`.
Source: `Kura-etnPL/SovereignBot`, branch `codex/aistudio-frontend-20260905`,
commit `eb91ec6a2158081cb72b5fc506fedd121de4752b` (rechecked against GitHub).

The branches diverge from main: 244 local-only commits and 2 export-branch commits.
This integrates the newer frontend, rather than replacing the complete desktop
runtime with the older runtime included in the AI Studio export.

Imported robot avatars, motion/interaction assets, color palettes, Markdown chat
formatting, conversation starters, layout updates and new translations.
The desktop custom-protocol asset allowlist includes the new local resources.
Existing jobs, Computer/This PC, Teach Once, Worker Nodes, artifacts lifecycle,
conversation paging/refresh and backend authority remain in place.

Desktop adaptation retains the sandboxed preload and strict CSP, excludes the
web-only HTTP bridge and Google Drive/Firebase login surface, and omits the
export's clipboard preview that never actually submitted an attachment.
Markdown rendering escapes untrusted content and filters rendered DOM tags and
attributes. Existing language settings continue to control locale.

Validation uses isolated local fixtures, not user data or real model calls:
Search/Command Palette, Settings, Work/Job actions and Channels Electron gates
all passed. Desktop
asset and product-shell checks (22 passing). New renderer globals and Markdown
formatting/injection cases were exercised in a hidden Electron window.
Syntax checks passed (306 existing checked files, plus explicit checks of all UI JavaScript).
The old palette gate now permits the added theme action while still requiring
all seven runtime commands. Channel checks use localized status labels.

Screenshots were inspected with finite entrance animations completed for hidden
window capture. The export contains inline decorative style attributes blocked
by the retained CSP; this integration does not weaken CSP to enable them.
No installed application, installer, release, GitHub push or main merge was
performed. The separate `projects/SovereignBot` checkout and five pre-existing
modified evidence files in this checkout were left unchanged.
