// `npm test` in this folder. Nothing here reaches GitHub, X or Claude: fetch
// is replaced with a fake that records what would have been sent.
import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signature, authHeader } from './x.js';
import { postLength, templatePost, LIMIT } from './draft.js';

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

await check('the signature matches the worked example in X\'s OAuth 1.0a docs', () => {
  const params = {
    include_entities: 'true',
    status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
    oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog',
    oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: '1318622958',
    oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    oauth_version: '1.0',
  };
  const sig = signature('POST', 'https://api.twitter.com/1.1/statuses/update.json', params,
    'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw', 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE');
  assert.equal(sig, 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
});

await check('the header carries every oauth field and the signature', () => {
  const env = { X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_TOKEN_SECRET: 'ts' };
  const h = authHeader('POST', 'https://api.x.com/2/tweets', env, { nonce: 'n', timestamp: '1' });
  for (const f of ['oauth_consumer_key="k"', 'oauth_nonce="n"', 'oauth_token="t"', 'oauth_timestamp="1"', 'oauth_signature="']) {
    assert.ok(h.includes(f), `${f} missing from ${h}`);
  }
});

await check('a link counts 23 characters and an emoji two, as X counts them', () => {
  assert.equal(postLength('hi https://example.com/a/very/long/path/indeed'), 3 + 23);
  assert.equal(postLength('🔥'), 2);
});

await check('the template fits a post, however long the title', () => {
  const link = 'https://github.com/vdblights/Cyrus-game';
  const short = templatePost({ title: 'Doors open and close.' }, link);
  assert.equal(short, `ASHFALL dev log: Doors open and close.\n\n${link} #gamedev #indiedev`);
  const long = templatePost({ title: 'word '.repeat(100) }, link);
  assert.ok(postLength(long) <= LIMIT, `${postLength(long)} characters`);
  assert.ok(long.includes('…'));
});

// run.js reads its inputs from the environment and runs on import.
const dir = await mkdtemp(join(tmpdir(), 'devlog-'));
let runs = 0;
async function run(env, routes) {
  const sent = [];
  const saved = { ...process.env };
  Object.assign(process.env, {
    GITHUB_REPOSITORY: 'vdblights/Cyrus-game', GITHUB_TOKEN: 'gh', DEVLOG_LINK: 'https://example.com/play',
    ANTHROPIC_API_KEY: '', DEVLOG_AUTOPOST: '', X_API_KEY: '', X_API_SECRET: '', X_ACCESS_TOKEN: '', X_ACCESS_TOKEN_SECRET: '',
  }, env);
  globalThis.fetch = async (url, init = {}) => {
    sent.push({ url, method: init.method ?? 'GET', body: init.body && JSON.parse(init.body) });
    const hit = routes.find(([m, re]) => m === (init.method ?? 'GET') && re.test(url));
    if (!hit) throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
    const body = hit[2];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  let error = null;
  try { await import(`./run.js?${++runs}`); } catch (e) { error = e; }
  process.env = saved;
  return { sent, error };
}

async function mergedEvent(pr) {
  const path = join(dir, `event${runs}.json`);
  await writeFile(path, JSON.stringify({ pull_request: pr }));
  return { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: path };
}

const PR = { number: 57, merged: true, title: 'Hang doors in some shop doorways', body: '', user: { login: 'vdblights' }, labels: [] };

await check('a merged PR gets a draft comment, and nothing goes to X', async () => {
  const { sent, error } = await run(await mergedEvent(PR), [
    ['GET', /issues\/57\/comments/, []],
    ['POST', /issues\/57\/comments/, {}],
  ]);
  assert.equal(error, null);
  assert.ok(!sent.some((s) => s.url.includes('x.com')));
  const body = sent.find((s) => s.method === 'POST').body.body;
  assert.ok(body.startsWith('<!-- ashfall-devlog draft -->'));
  assert.ok(body.includes('ASHFALL dev log: Hang doors in some shop doorways.'));
});

await check('a closed PR, a bot\'s PR and a no-devlog PR get nothing', async () => {
  for (const pr of [{ ...PR, merged: false }, { ...PR, user: { login: 'dependabot[bot]' } }, { ...PR, labels: [{ name: 'no-devlog' }] }]) {
    const { sent, error } = await run(await mergedEvent(pr), []);
    assert.equal(error, null);
    assert.equal(sent.length, 0);
  }
});

const X = { X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_TOKEN_SECRET: 'ts' };
const DRAFT = '<!-- ashfall-devlog draft -->\nDraft\n\n```text\nEdited by hand.\n\nhttps://example.com/play\n```\n\nfoot';

await check('posting by hand sends the text in the comment, as edited', async () => {
  const { sent, error } = await run({ ...X, GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_PR: '57', INPUT_POST: 'true', DEVLOG_HANDLE: 'ashfallgame' }, [
    ['GET', /pulls\/57$/, PR],
    ['GET', /issues\/57\/comments/, [{ id: 9, body: DRAFT }]],
    ['POST', /api\.x\.com\/2\/tweets/, { data: { id: '123' } }],
    ['PATCH', /issues\/comments\/9/, {}],
  ]);
  assert.equal(error, null);
  assert.equal(sent.find((s) => s.url.includes('x.com')).body.text, 'Edited by hand.\n\nhttps://example.com/play');
  const patched = sent.find((s) => s.method === 'PATCH').body.body;
  assert.ok(patched.startsWith('<!-- ashfall-devlog posted:123 -->'));
  assert.ok(patched.includes('https://x.com/ashfallgame/status/123'));
});

await check('a PR already posted is not posted twice by accident', async () => {
  const { sent, error } = await run({ ...X, GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_PR: '57', INPUT_POST: 'true' }, [
    ['GET', /pulls\/57$/, PR],
    ['GET', /issues\/57\/comments/, [{ id: 9, body: '<!-- ashfall-devlog posted:123 -->\n```text\nx\n```' }]],
  ]);
  assert.match(error?.message ?? '', /already posted/);
  assert.ok(!sent.some((s) => s.url.includes('x.com')));
});

await check('autopost posts a merged PR straight away, and only with every key set', async () => {
  const ok = await run({ ...X, ...(await mergedEvent(PR)), DEVLOG_AUTOPOST: 'true' }, [
    ['GET', /issues\/57\/comments/, []],
    ['POST', /api\.x\.com\/2\/tweets/, { data: { id: '5' } }],
    ['POST', /issues\/57\/comments/, {}],
  ]);
  assert.equal(ok.error, null);
  assert.ok(ok.sent.some((s) => s.url.includes('x.com')));
  const missing = await run({ ...(await mergedEvent(PR)), DEVLOG_AUTOPOST: 'true', X_API_KEY: 'k' }, [
    ['GET', /issues\/57\/comments/, []],
  ]);
  assert.match(missing.error?.message ?? '', /X secrets/);
});

console.log(`${passed}/${passed} devlog checks passed`);
