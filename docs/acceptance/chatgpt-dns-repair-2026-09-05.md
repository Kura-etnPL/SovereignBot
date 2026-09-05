# ChatGPT scoped DNS repair — 2026-09-05

User explicitly authorized diagnosing and correcting Mihomo DNS for ChatGPT,
without disabling SovereignBot safety checks or changing unrelated projects.

## Applied

Active Clash Verge profile: `GCPw11787693069`; enhancement merge:
`C:/Users/Eternal/AppData/Roaming/io.github.clash-verge-rev.clash-verge-rev/profiles/mnyJR5NkoOa0.yaml`.
The merge was previously only its template comment. Added DNS exceptions for
`+.chatgpt.com`, `+.oaistatic.com`, `+.oaiusercontent.com`, and `auth.openai.com`:

- `fake-ip-filter-mode: blacklist` and the four `fake-ip-filter` entries.
- Matching `nameserver-policy` entries using
  `https://8.8.8.8/dns-query#GOOGLE`, through the existing GOOGLE route.

Applied the same scoped DNS block to the current generated `clash-verge.yaml`
and reloaded through the authenticated loopback controller (HTTP 204). No node,
route, TUN, port, subscription, global DNS mode or system proxy setting changed.
No keys were logged or copied into this evidence. No core restart or global cache
flush was performed. The enhancement persists for this profile; other profiles
were deliberately untouched.

Rollback: remove only these four filter and policy entries from both files,
removing the added empty containers/mode afterward, then reload the same config.
Preserve any later user edits. No full secret-bearing config backup was created.

## Results

- Before: chatgpt.com resolved to 198.18.0.30 and production egress rejected it.
- Fake-IP exclusion alone exposed an anomalous 104.244.46.208 answer; independent
  Google DNS lookup returned different addresses. Scoped encrypted resolution was
  therefore added, rather than accepting that default resolver result.
- After: chatgpt.com = 104.18.32.47 / 172.64.155.209; auth.openai.com =
  104.18.41.241 / 172.64.146.15; cdn.oaistatic.com =
  104.18.41.158 / 172.64.146.98. These are observations, not pinned addresses.
- Control domain example.com remained Fake-IP 198.18.0.8.
- Production W3C driver reached https://chatgpt.com/, but the page title remained
  `请稍候…` with no login controls or authenticated session. Stopped at this site
  check, without sending any prompt or switching browser instances to bypass it.
- Fixed the read-only projection to classify this Chinese site-check title as a
  challenge, instead of falsely reporting no challenge. Localized-title regression
  test passes; browser validation is not repeated past the security boundary.
- Probe-owned Chrome processes left after driver shutdown were stopped by their
  exact project test profile path. No user browser or other project was stopped.
  The driver's incomplete process cleanup is a remaining local reliability issue.

DNS/network-address blocking is resolved. Authenticated desktop Chat/Sol execution
is still unverified and requires normal user site verification/sign-in. The earlier
in-app browser Sol probe is not a substitute for this dedicated profile.

References: [Mihomo DNS](https://wiki.metacubex.one/config/dns/) and
[configuration reload API](https://wiki.metacubex.one/api/).
