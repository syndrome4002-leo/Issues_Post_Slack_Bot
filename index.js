require('dotenv').config();
const { WebClient } = require('@slack/web-api');
const fs = require('fs');
const path = require('path');

const slackToken = process.env.SLACK_BOT_TOKEN;
const channel = process.env.SLACK_CHANNEL_ID;
const githubToken = process.env.GITHUB_TOKEN;
const repoDelayMs = Number(process.env.REPO_DELAY_SECONDS || 20) * 1000;

const DEFAULT_REPOS = [
  'OpenHands/OpenHands',
  'virattt/dexter',
  'llmsresearch/paperbanana',
  'ClickHouse/ClickHouse',
  'entrius/allways',
  'we-promise/sure',
  'infiniflow/ragflow',
  'penpot/penpot',
  'run-llama/llama_index',
  'Unstructured-IO/unstructured',
  'AffineFoundation/affinetes',
  'entrius/gittensor-ui',
  'eigent-ai/eigent',
  'openclaw/openclaw',
  'entrius/gittensor',
];

// Accepts "owner/repo", a github.com URL, optionally with .git suffix.
function normalizeRepo(input) {
  const trimmed = input.trim().replace(/\.git$/, '').replace(/\/$/, '');
  const m = trimmed.match(/(?:github\.com\/)?([^\/\s]+\/[^\/\s]+)$/);
  return m ? m[1] : null;
}

const watchedRepos = (process.env.REPOS
  ? process.env.REPOS.split(',')
  : DEFAULT_REPOS
)
  .map(normalizeRepo)
  .filter(Boolean);

if (!slackToken || !channel) {
  console.error('Missing SLACK_BOT_TOKEN or SLACK_CHANNEL_ID in environment.');
  process.exit(1);
}
if (watchedRepos.length === 0) {
  console.error('No repos configured.');
  process.exit(1);
}

const slack = new WebClient(slackToken);
const stateFile = path.join(__dirname, '.state.json');

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    // Old single-repo shape — discard so each repo re-baselines.
    if (typeof data.lastIssueNumber === 'number') return {};
    return data;
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchIssues(repo) {
  const url = `https://api.github.com/repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=30`;
  const headers = {
    'User-Agent': 'slackbot-issue-watcher',
    Accept: 'application/vnd.github+json',
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  }
  const items = await res.json();
  return items.filter((i) => !i.pull_request);
}

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function authorBadge(association) {
  if (MAINTAINER_ASSOCIATIONS.has(association)) {
    return `:shield: maintainer (${association.toLowerCase()})`;
  }
  if (association === 'CONTRIBUTOR') return ':seedling: past contributor';
  if (association === 'FIRST_TIME_CONTRIBUTOR' || association === 'FIRST_TIMER') {
    return ':wave: first-time contributor';
  }
  return ':bust_in_silhouette: external';
}

function formatIssue(repo, issue) {
  const labels = issue.labels.map((l) => l.name).join(', ') || 'none';
  const badge = authorBadge(issue.author_association);
  return [
    `:bell: New issue in *${repo}*`,
    `*<${issue.html_url}|#${issue.number}: ${issue.title}>*`,
    `Opened by *${issue.user.login}* — ${badge}  ·  Labels: ${labels}`,
  ].join('\n');
}

async function postToSlack(text) {
  await slack.chat.postMessage({ channel, text, unfurl_links: false });
}

async function checkRepo(repo) {
  let issues;
  try {
    issues = await fetchIssues(repo);
  } catch (err) {
    console.error(`[${repo}] GitHub fetch failed: ${err.message}`);
    return;
  }

  const state = loadState();
  const repoState = state[repo] || { lastIssueNumber: 0, initialized: false };

  if (!repoState.initialized) {
    const highest = issues.reduce((m, i) => Math.max(m, i.number), 0);
    state[repo] = { lastIssueNumber: highest, initialized: true };
    saveState(state);
    console.log(`[${repo}] Initialized, watching for issues newer than #${highest}.`);
    return;
  }

  const newIssues = issues
    .filter((i) => i.number > repoState.lastIssueNumber)
    .sort((a, b) => a.number - b.number);

  if (newIssues.length === 0) {
    console.log(`[${repo}] No new issues (last seen #${repoState.lastIssueNumber}).`);
    return;
  }

  for (const issue of newIssues) {
    try {
      await postToSlack(formatIssue(repo, issue));
      console.log(`[${repo}] Notified: #${issue.number} ${issue.title}`);
      repoState.lastIssueNumber = issue.number;
      state[repo] = repoState;
      saveState(state);
    } catch (err) {
      console.error(`[${repo}] Slack post failed for #${issue.number}:`, err.data || err.message);
      break;
    }
  }
}

async function main() {
  const cycleMin = (watchedRepos.length * repoDelayMs / 1000 / 60).toFixed(1);
  console.log(`Watching ${watchedRepos.length} repos with ${repoDelayMs / 1000}s between each (≈${cycleMin} min per cycle).`);
  console.log(`Repos: ${watchedRepos.join(', ')}`);

  while (true) {
    for (const repo of watchedRepos) {
      await checkRepo(repo);
      await sleep(repoDelayMs);
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
