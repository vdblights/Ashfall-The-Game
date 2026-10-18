// The devlog workflow's one entry point (.github/workflows/devlog.yml).
//
// A merged pull request gets a draft post as a comment on it. Nothing goes to
// X unless one of two things says so:
//   - someone runs the workflow by hand with `post` on, which posts the text
//     in that comment (edit the comment first to change it); or
//   - the repo variable DEVLOG_AUTOPOST is `true`, which posts every draft as
//     soon as it is written.
import { readFile } from 'node:fs/promises';
import { draftPost, postLength, LIMIT } from './draft.js';
import { postToX, xConfigured } from './x.js';

const env = process.env;
const REPO = env.GITHUB_REPOSITORY;
const MARK = '<!-- ashfall-devlog';
const API = 'https://api.github.com';

async function gh(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function findComment(number) {
  const comments = await gh(`/repos/${REPO}/issues/${number}/comments?per_page=100`);
  return comments.find((c) => c.body.startsWith(MARK)) ?? null;
}

async function saveComment(number, existing, body) {
  if (existing) return gh(`/repos/${REPO}/issues/comments/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ body }) });
  return gh(`/repos/${REPO}/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
}

const block = (text) => '```text\n' + text + '\n```';

function draftBody(number, text, by) {
  return `${MARK} draft -->
**Dev log draft** — not posted to X.

${block(text)}

${postLength(text)}/${LIMIT} characters, written by ${by === 'claude' ? 'Claude' : 'the template'}. To post it, edit the text above if you want to, then run **Actions → Devlog → Run workflow** with PR \`${number}\` and **post** ticked.`;
}

function postedBody(text, id, handle) {
  const url = handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/web/status/${id}`;
  return `${MARK} posted:${id} -->
**Posted to X:** ${url}

${block(text)}`;
}

function draftIn(comment) {
  const m = comment?.body.match(/```text\n([\s\S]*?)\n```/);
  return m ? m[1] : null;
}

// Dependabot's bumps and anything labelled no-devlog are not news.
function skip(pr) {
  if (pr.user?.login?.endsWith('[bot]')) return `opened by ${pr.user.login}`;
  if (pr.labels?.some((l) => l.name === 'no-devlog')) return 'labelled no-devlog';
  return null;
}

const link = () => env.DEVLOG_LINK || `https://github.com/${REPO}`;

async function publish(number, text, comment) {
  if (postLength(text) > LIMIT) throw new Error(`The post is ${postLength(text)} characters, over X's ${LIMIT}`);
  const id = await postToX(text);
  await saveComment(number, comment, postedBody(text, id, env.DEVLOG_HANDLE));
  console.log(`Posted ${id}`);
}

async function onMerged(pr) {
  if (!pr.merged) return console.log('Closed without merging; nothing to say.');
  const why = skip(pr);
  if (why) return console.log(`Skipping #${pr.number}: ${why}.`);
  const comment = await findComment(pr.number);
  if (comment) return console.log(`#${pr.number} already has a dev log comment.`);
  const { text, by } = await draftPost(pr, link());
  console.log(`Draft (${by}, ${postLength(text)} characters):\n${text}`);
  if (env.DEVLOG_AUTOPOST === 'true') {
    if (!xConfigured()) throw new Error('DEVLOG_AUTOPOST is on but the X secrets are not all set');
    return publish(pr.number, text, null);
  }
  await saveComment(pr.number, null, draftBody(pr.number, text, by));
}

async function onDispatch() {
  const number = Number(env.INPUT_PR);
  if (!Number.isInteger(number) || number < 1) throw new Error(`"${env.INPUT_PR}" is not a pull request number`);
  const pr = await gh(`/repos/${REPO}/pulls/${number}`);
  const comment = await findComment(number);
  const override = env.INPUT_TEXT?.trim();

  if (env.INPUT_POST !== 'true') {
    // Draft again, replacing an earlier draft but never a posted record.
    if (comment?.body.startsWith(`${MARK} posted:`)) throw new Error(`#${number} was already posted`);
    const { text, by } = override ? { text: override, by: 'hand' } : await draftPost(pr, link());
    await saveComment(number, comment, draftBody(number, text, by));
    return console.log(`Draft saved on #${number}:\n${text}`);
  }

  if (comment?.body.startsWith(`${MARK} posted:`) && !override) {
    throw new Error(`#${number} was already posted; give the text input to post again on purpose`);
  }
  const text = override || draftIn(comment);
  if (!text) throw new Error(`#${number} has no draft to post; run once without post to draft one`);
  await publish(number, text, comment);
}

const name = env.GITHUB_EVENT_NAME;
if (name === 'pull_request') {
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  await onMerged(event.pull_request);
} else if (name === 'workflow_dispatch') {
  await onDispatch();
} else {
  throw new Error(`Not written for ${name} events`);
}
