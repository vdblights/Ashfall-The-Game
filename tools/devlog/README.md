# Dev log on X

Every pull request merged into `main` gets a draft post about the game, left
as a comment on the PR by the `Devlog` workflow
(`.github/workflows/devlog.yml`). Nothing is posted to X until you say so.

## How a post goes out

1. A PR merges. A comment appears on it with the draft in a box.
2. Edit the comment if you want different words. The text in the box is what
   gets posted.
3. Open **Actions → Devlog → Run workflow**, enter the PR number, tick
   **post**, and run it. The comment changes to a link to the post.

Untick **post** to draft again instead, which replaces the comment's draft
(or fill in **text** to set it by hand). A PR that was already posted is
refused unless you fill in **text**, so one is never posted twice by
accident. Label a PR `no-devlog` to skip it; Dependabot's are skipped
anyway.

**Fully automatic:** set the repository variable `DEVLOG_AUTOPOST` to `true`
and every merged PR is posted the moment it merges, no comment step. Unset it
to go back.

## Setting it up

All of this is in your own accounts; none of it goes in the repo or in chat.

### 1. The X account and its keys

1. Create the X account for the game (for example `@ashfallgame`) and sign in
   as it.
2. Go to <https://developer.x.com>, sign up for a developer account as that
   account, and check what the current plan allows: you need to be able to
   create posts through the API.
3. In the developer portal, create a Project and an App inside it.
4. In the App's **User authentication settings**, set app permissions to
   **Read and write** (type: Web App or Automated App/Bot; any callback URL,
   such as your game's URL, is fine since this never signs anyone in).
5. In the App's **Keys and tokens**, copy the **API Key and Secret**, then
   generate an **Access Token and Secret**. Generate the access token *after*
   step 4, or it will be read-only and posting fails with a 403.

### 2. Into GitHub

In the repo, **Settings → Secrets and variables → Actions**:

| Secrets | From |
| --- | --- |
| `X_API_KEY` | API Key |
| `X_API_SECRET` | API Key Secret |
| `X_ACCESS_TOKEN` | Access Token |
| `X_ACCESS_TOKEN_SECRET` | Access Token Secret |
| `ANTHROPIC_API_KEY` | optional, from <https://console.anthropic.com> |

| Variables (all optional) | What |
| --- | --- |
| `DEVLOG_LINK` | the link every post ends with, such as where the game is hosted; the repo if unset |
| `DEVLOG_HANDLE` | the account's handle without `@`, for the link back to each post |
| `DEVLOG_AUTOPOST` | `true` to post every merge without asking |

Without `ANTHROPIC_API_KEY` a draft is a template off the PR's title
("ASHFALL dev log: …"). With it, Claude writes the draft from the PR's title
and description for a player to read, and the template is the fallback.

## Checks

```bash
cd tools/devlog && npm ci && npm test
```

Nothing in them reaches GitHub, X or Claude. The signing is checked against
the worked example in X's OAuth 1.0a documentation; CI runs them on every PR.
