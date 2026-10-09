---
"@yuzie/server": minor
---

Sign in with GitHub (SPEC.md §6.1).

**How to turn it on.** Give the server a GitHub OAuth App: set `YUZIE_GITHUB_CLIENT_ID` and
`YUZIE_GITHUB_CLIENT_SECRET`. Nothing changes without them.

**What it does.**
- The device page shows "Sign in with GitHub", and a Yuzie handle is the person's GitHub
  username.
- Approving a code by typing a handle is refused, except for a device of the person already
  signed in. This closes the gap where a handle with no active token could be claimed by anyone.
- Existing accounts are linked to the GitHub user with the same name on first sign-in.
- The app asks GitHub for no scopes, and the server keeps no GitHub tokens.

**Also.**
- `YUZIE_GITHUB_URL` and `YUZIE_GITHUB_API_URL` support GitHub Enterprise Server.
- The self-hosting guide and compose file cover all of it.
