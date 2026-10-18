# Dev log on X

The game's X account gets two kinds of post, and both are drafts until you
say otherwise:

- **Updates.** Every pull request merged into `main` gets a draft post about
  it, left as a comment on the PR by the `Devlog` workflow
  (`.github/workflows/devlog.yml`).
- **Everything else.** Three times a week (Monday, Wednesday and Friday,
  16:00 UTC) the `Devlog schedule` workflow drafts a post on another topic,
  as an issue labelled `devlog`. The topics take turns: a transmission from
  Carrow, a look behind a mechanic (one of the lessons in `CLAUDE.md`), a tip
  from HALCYON (the loading screen's field notes), and a city to try by its
  seed. Scheduled posts need `ANTHROPIC_API_KEY`. Run that workflow by hand
  to get one now, and pick a topic if you like.

## The voice

[`voice.md`](voice.md) is how the account sounds, and Claude reads it for
every post. There are two registers: a dry first-person **diary** for posts
about building the game, and **radio** for posts from inside Carrow, in
HALCYON's voice, drawing only on the game's story. Edit the file to change
how the account sounds; the next post follows it. Claude is also shown the
account's last ten drafts, so it doesn't repeat itself.

## How a post goes out

Free, with no X developer account:

1. A draft appears: a comment on a merged PR, or a new `devlog` issue.
   GitHub tells you as it does for any comment or issue, by email or in its
   app.
2. Tap **Post it on X** under the draft. X opens, on the web or in its app,
   with the post filled in for whichever account you are signed in as.
   Check it and press Post.
3. Close a draft issue once it is posted. To drop one, just close it.

The link carries the text as drafted. If you edit the box, copy the text
into X instead. Label a PR `no-devlog` to skip it; Dependabot's are skipped
anyway.

**Posting from the workflow (optional, paid).** X's API now charges for every
post it creates, and more for a post with a link in it, which every post
here has. If you add the X keys (below), each draft also offers a second
way: open **Actions → Devlog → Run workflow**, enter the PR or issue number,
tick **post**, and run it. It posts the text in the box, as edited, and the
draft changes to a link to the post. Anything already posted is refused
unless you fill in **text**, so nothing is posted twice by accident. To
draft a PR's post again, run it with **post** unticked.

**Fully automatic** needs the keys too: set the repository variable
`DEVLOG_AUTOPOST` to `true` and every draft is posted the moment it is
written. Unset it to go back. To stop the scheduled drafts, disable the
`Devlog schedule` workflow in the Actions tab.

## Setting it up

All of this is in your own accounts; none of it goes in the repo or in chat.

### 1. The X account

Create the X account for the game and sign in to it on your phone and your
browser. That is all the free way needs.

**Only for posting from the workflow:** go to <https://developer.x.com> as
that account and buy API credit (it is pay as you go; check the current price
per post there). Create an App, set its **User authentication settings** to
**Read and write**, then in **Keys and tokens** copy the **API Key and
Secret** and generate an **Access Token and Secret**. Generate the token
*after* setting Read and write, or it is read-only and posting fails with a
403.

### 2. Into GitHub

In the repo, **Settings → Secrets and variables → Actions**:

| Secrets | From |
| --- | --- |
| `ANTHROPIC_API_KEY` | from <https://console.anthropic.com>; writes the drafts |
| `X_API_KEY` | API Key (optional, paid) |
| `X_API_SECRET` | API Key Secret |
| `X_ACCESS_TOKEN` | Access Token |
| `X_ACCESS_TOKEN_SECRET` | Access Token Secret |

| Variables (all optional) | What |
| --- | --- |
| `DEVLOG_LINK` | the link every post ends with, such as where the game is hosted; the repo if unset |
| `DEVLOG_HANDLE` | the account's handle without `@`, for the link back to each post |
| `DEVLOG_AUTOPOST` | `true` to post every draft without asking (needs the X keys) |

Without `ANTHROPIC_API_KEY` an update's draft is a template off the PR's
title ("ASHFALL dev log: …") and there are no scheduled posts. With it,
Claude writes every draft in the voice, and the template is the update's
fallback. A draft costs a few cents of API use.

`DEVLOG_LINK` is worth setting to wherever the game is played: the seed
posts only run with it, because they link straight to one city.

## Checks

```bash
cd tools/devlog && npm ci && npm test
```

Nothing in them reaches GitHub, X or Claude. The signing is checked against
the worked example in X's OAuth 1.0a documentation; CI runs them on every PR.
