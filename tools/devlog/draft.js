// Turns a merged pull request into a post about the game.
//
// Without ANTHROPIC_API_KEY the post is a template off the PR's title. With
// it, Claude writes the post from the title and description, and the template
// is the fallback whenever that fails or comes back too long.

// X counts every link as 23 characters whatever its length, and anything
// outside the Basic Multilingual Plane (most emoji) as two.
export const LIMIT = 280;
const LINK = 23;

export function postLength(text) {
  let n = 0;
  for (const word of text.split(/(\s+)/)) {
    if (/^https?:\/\/\S+$/.test(word)) { n += LINK; continue; }
    for (const ch of word) n += ch.codePointAt(0) > 0xffff ? 2 : 1;
  }
  return n;
}

const TAGS = '#gamedev #indiedev';

export function templatePost(pr, link) {
  const title = pr.title.trim().replace(/[.\s]+$/, '');
  const tail = `\n\n${link} ${TAGS}`;
  let text = `ASHFALL dev log: ${title}.${tail}`;
  if (postLength(text) > LIMIT) {
    // Cut the title at a word, leaving room for the ellipsis.
    const room = LIMIT - postLength(`ASHFALL dev log: …${tail}`);
    let cut = '';
    for (const word of title.split(' ')) {
      const next = cut ? `${cut} ${word}` : word;
      if (postLength(next) > room) break;
      cut = next;
    }
    text = `ASHFALL dev log: ${cut}…${tail}`;
  }
  return text;
}

const SYSTEM = `You write short posts for the X account that follows the development of ASHFALL, a free browser first-person shooter: wave survival in a procedurally generated ruined city, hand-written in JavaScript with three.js, no downloads.

You are given one pull request that was just merged. Write one post about it for players and other developers.

- Say what changed in the game in plain words a player would notice. Skip internals (function names, file names, check counts, seeds) unless the change is only internal, in which case say what it makes possible or better.
- Never claim anything the pull request does not say.
- No hype words, no exclamation marks, no emoji. At most one hashtag, #gamedev, at the end.
- Under 230 characters. Do not include any link; one is added after your text.
- Reply with the post text and nothing else.`;

async function claudePost(pr) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `Title: ${pr.title}\n\nDescription:\n${pr.body || '(none)'}`,
    }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude declined to write the post');
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
    .replace(/^"(.*)"$/s, '$1');
  if (!text) throw new Error('Claude returned no text');
  return text;
}

export async function draftPost(pr, link) {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const text = `${await claudePost(pr)}\n\n${link}`;
      if (postLength(text) <= LIMIT) return { text, by: 'claude' };
      console.warn(`Claude's post was ${postLength(text)} characters; using the template`);
    } catch (err) {
      console.warn(`Claude could not draft the post (${err.message}); using the template`);
    }
  }
  return { text: templatePost(pr, link), by: 'template' };
}
