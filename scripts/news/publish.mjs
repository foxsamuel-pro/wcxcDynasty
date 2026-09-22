import { readFile, writeFile, rename, mkdir, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadSnapshot, loadFacts } from './data.mjs';
import { planPosts } from './schedule.mjs';
import { SYSTEM, BATCH_SCHEMA, editorialFacts, assembleArticle } from './writer.mjs';

const newsURL = new URL('../../news.json', import.meta.url);
const fingerprint = text => createHash('sha256').update(text).digest('hex');

// The GitHub Claude action receives this assignment as its scheduled prompt.
// This module never calls an AI API or reads an AI credential.
export async function prepare({ now = new Date(), newsFile = newsURL, directory = '.news-run',
  getSnapshot = loadSnapshot, getFacts = loadFacts } = {}) {
  const text = await readFile(newsFile, 'utf8'), news = JSON.parse(text);
  if (!Array.isArray(news.articles)) throw new Error('Invalid news archive');
  const snapshot = await getSnapshot(now);
  const jobs = snapshot ? planPosts({ now, ...snapshot, articles: news.articles,
    ballotCount: (snapshot.ballotsByWeek[snapshot.week] || []).length }) : [];
  const editions = [];
  for (const job of jobs) {
    const facts = editorialFacts(await getFacts(snapshot, job), news.articles, now);
    editions.push({ job, facts });
    console.log(JSON.stringify({ id: job.id, kind: job.kind, ballotCount: facts.ballotCount,
      matchups: facts.matchups.length, players: facts.players.length }));
  }
  const assignment = { instructions: SYSTEM, preparedAt: new Date(now).toISOString(),
    archiveFingerprint: fingerprint(text), editions, schema: BATCH_SCHEMA,
    recentStories: news.articles.slice(0, 12).map(a => ({ date: a.date, kind: a.kind, headline: a.headline, dek: a.dek })) };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'assignment.json'), JSON.stringify(assignment, null, 2));
  if (!editions.length) console.log('No unpublished editions due.');
  return assignment;
}

export async function finalize({ newsFile = newsURL, directory = '.news-run', drafts, now = new Date() } = {}) {
  const assignment = JSON.parse(await readFile(join(directory, 'assignment.json'), 'utf8'));
  const text = await readFile(newsFile, 'utf8');
  if (fingerprint(text) !== assignment.archiveFingerprint) throw new Error('Archive changed while Claude was writing; retry with fresh data');
  const age = new Date(now) - new Date(assignment.preparedAt);
  if (!Number.isFinite(age) || age < 0 || age > 30 * 60000) throw new Error('Assignment expired; refresh league data before publishing');
  if (!drafts || !Array.isArray(drafts.drafts) || drafts.drafts.length !== assignment.editions.length ||
      new Set(drafts.drafts.map(d => d.id)).size !== drafts.drafts.length) {
    throw new Error('Claude must return exactly one draft per due edition');
  }
  const articles = assignment.editions.map(({ job, facts }) => {
    if (job.expiresAt && new Date(now).getTime() >= job.expiresAt) throw new Error('Preview kickoff has passed; do not publish a stale preview');
    const draft = drafts.drafts.find(d => d.id === job.id);
    if (!draft) throw new Error(`Missing edition: ${job.id}`);
    return assembleArticle(draft.article, job, facts, now);
  });
  // Validate the whole batch before making any change to the archive.
  if (articles.length) {
    const news = JSON.parse(text);
    news.note = 'Scheduled editions written by Claude Code from WCXC league data. Satire is labeled fiction.';
    news.articles = [...articles, ...news.articles].sort((a, b) => b.date.localeCompare(a.date));
    const temp = typeof newsFile === 'string' ? `${newsFile}.tmp` : new URL(`${newsFile.href}.tmp`);
    await writeFile(temp, `${JSON.stringify(news, null, 2)}\n`, 'utf8');
    await rename(temp, newsFile);
    console.log(`Published ${articles.length} edition(s): ${articles.map(a => a.id).join(', ')}`);
  }
  return articles;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--prepare', '--finalize', '--dry-run'].includes(args[0])) {
    throw new Error('Usage: node scripts/news/publish.mjs --prepare|--finalize|--dry-run');
  }
  if (args[0] === '--finalize') {
    await finalize({ drafts: JSON.parse(process.env.CLAUDE_NEWS_DRAFTS || 'null') });
  } else {
    const assignment = await prepare();
    if (args[0] === '--prepare' && process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `due=${assignment.editions.length > 0}\nschema=${JSON.stringify(BATCH_SCHEMA)}\n`);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
