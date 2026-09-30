#!/usr/bin/env node
/**
 * Refreshes the auto-generated sections of the profile README.
 *
 *   <!--START_SECTION:activity--> ... <!--END_SECTION:activity-->
 *     the 10 latest public events (commits, pull requests, issues, releases, comments)
 *   <!--START_SECTION:projects--> ... <!--END_SECTION:projects-->
 *     public repositories active in the last ACTIVE_DAYS days (excluding pinned ones),
 *     followed by the curated private-projects list
 *
 * GitHub Actions runs it with the default GITHUB_TOKEN; locally:
 *   GITHUB_TOKEN="$(gh auth token)" node scripts/update-profile-readme.mjs
 *
 * All fetched data is public; private projects appear only through the curated
 * PRIVATE_PROJECTS config (name + description, never links or events).
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const USERNAME = "itokun99";
const README_PATH = fileURLToPath(new URL("../README.md", import.meta.url));

// --- activity section config ---
const MAX_LINES = 10;
const MAX_CANDIDATES = 30; // events collected before merging trims to MAX_LINES
const ACTIVITY_TYPES = new Set([
  "PushEvent",
  "PullRequestEvent",
  "IssuesEvent",
  "ReleaseEvent",
  "IssueCommentEvent",
  "DiscussionEvent",
]);

// --- projects section config ---
const ACTIVE_DAYS = 90;
const MAX_PROJECTS = 6;
const REQUIRE_DESCRIPTION = true; // repos without a GitHub description are skipped
const EXCLUDE_REPOS = new Set([
  "itokun99/itokun99", // this profile repo itself
  "itokun99/kuliahan", // coursework, not a portfolio project
]);
// GITHUB_TOKEN in Actions cannot read other private repos, so this list is curated here.
const PRIVATE_PROJECTS = [
  { name: "sundabuilder", description: "Sunda-inspired digital portfolio platform — modern static web with a Sundanese cultural identity." },
  { name: "pagawe", description: "HRIS monorepo — Hono + Drizzle (MySQL) backend with a React admin app, Bun tooling, deployed via Dokploy." },
  { name: "layan", description: "AI-powered restaurant ordering platform — multi-tenant Go microservices with a conversational ordering interface." },
  { name: "spark-ai-workflow", description: "Evaluation memory bank for an AI-agent workflow — patterns, violations, and lessons learned captured from agent runs." },
];
const PINNED_FALLBACK = [
  "itokun99/omotg",
  "itokun99/dailydev-mcp",
  "itokun99/oh-my-openagent",
  "itokun99/omo-tmux-dag",
  "itokun99/mono-robby",
  "itokun99/secure-storage",
];

const TOKEN = process.env.GITHUB_TOKEN || "";
const HEADERS = {
  accept: "application/vnd.github+json",
  "user-agent": "itokun99-profile-readme",
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
};

async function api(path, options = {}) {
  const { method = "GET", body, graphql = false } = options;
  const res = await fetch(graphql ? "https://api.github.com/graphql" : `https://api.github.com${path}`, {
    method,
    headers: { ...HEADERS, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${method} ${graphql ? "/graphql" : path} -> HTTP ${res.status}`);
  return res.json();
}

const oneLine = (text) => (text || "").replace(/\s+/g, " ").trim();
const truncate = (text, max) => {
  const t = oneLine(text);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
function timeAgo(iso) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days > 1 ? "s" : ""} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months > 1 ? "s" : ""} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years > 1 ? "s" : ""} ago`;
}

const isZeroSha = (sha) => !sha || /^0+$/.test(sha);
const repoLink = (full) => `[${full}](https://github.com/${full})`;

function websiteLink(homepage) {
  if (!homepage) return "";
  let url;
  try { url = new URL(homepage); } catch { try { url = new URL(`https://${homepage}`); } catch { return ""; } }
  if (/(^|\.)github\.com$/.test(url.hostname)) return "";
  return `[${url.hostname}](${url.href})`;
}

const publicRepoCache = new Map();
async function isPublicRepo(full) {
  if (!publicRepoCache.has(full)) {
    let isPublic = false;
    try {
      const repo = await api(`/repos/${full}`);
      isPublic = repo.private === false;
    } catch {
      isPublic = false; // 404 / no access -> treat as non-public
    }
    publicRepoCache.set(full, isPublic);
  }
  return publicRepoCache.get(full);
}

async function pushCommitInfo(full, payload) {
  if (isZeroSha(payload.before) || isZeroSha(payload.head)) return null;
  try {
    const compare = await api(`/repos/${full}/compare/${payload.before}...${payload.head}`);
    return {
      count: compare.total_commits,
      message: truncate((compare.commits?.[0]?.commit?.message || "").split("\n")[0], 70),
    };
  } catch {
    return null; // force-pushed or deleted history: fall back to a plain push line
  }
}

async function toEntry(event) {
  const full = event.repo.name;
  const date = event.created_at;
  const payload = event.payload || {};
  switch (event.type) {
    case "PushEvent": {
      const ref = (payload.ref || "").replace(/^refs\/(heads|tags)\//, "");
      const info = await pushCommitInfo(full, payload);
      return { kind: "push", repo: full, ref, count: info?.count ?? null, message: info?.message || "", date };
    }
    case "PullRequestEvent": {
      const pr = payload.pull_request || {};
      const verb =
        payload.action === "opened" ? "Opened"
        : payload.action === "reopened" ? "Reopened"
        : payload.action === "closed" ? (pr.merged ? "Merged" : "Closed")
        : null;
      if (!verb) return null;
      return { kind: "line", date, text: `🔀 ${verb} PR [#${payload.number}](${pr.html_url}) "${truncate(pr.title, 60)}" in ${repoLink(full)}` };
    }
    case "IssuesEvent": {
      const verb = { opened: "Opened", closed: "Closed", reopened: "Reopened" }[payload.action];
      if (!verb) return null;
      const issue = payload.issue || {};
      return { kind: "line", date, text: `🐛 ${verb} issue [#${issue.number}](${issue.html_url}) "${truncate(issue.title, 60)}" in ${repoLink(full)}` };
    }
    case "ReleaseEvent": {
      const release = payload.release || {};
      return { kind: "line", date, text: `🚀 Released [${release.tag_name}](${release.html_url}) in ${repoLink(full)}` };
    }
    case "IssueCommentEvent": {
      const issue = payload.issue || {};
      return { kind: "line", date, text: `💬 Commented on [#${issue.number}](${issue.html_url}) "${truncate(issue.title, 60)}" in ${repoLink(full)}` };
    }
    case "DiscussionEvent": {
      const verb = { created: "Created", answered: "Answered", closed: "Closed", reopened: "Reopened" }[payload.action];
      if (!verb) return null;
      const discussion = payload.discussion || {};
      return { kind: "line", date, text: `🗣️ ${verb} discussion [#${discussion.number}](${discussion.html_url}) "${truncate(discussion.title, 60)}" in ${repoLink(full)}` };
    }
    default:
      return null;
  }
}

function renderEntry(entry) {
  if (entry.kind === "line") return `- ${entry.text} · _${timeAgo(entry.date)}_`;
  const bits = [`📝 Pushed${entry.count ? ` ${entry.count} commit${entry.count > 1 ? "s" : ""}` : ""} to ${repoLink(entry.repo)}`];
  if (entry.ref) bits.push(`(\`${entry.ref}\`)`);
  if (entry.message) bits.push(`— "${entry.message}"`);
  return `- ${bits.join(" ")} · _${timeAgo(entry.date)}_`;
}

function mergeEntries(entries) {
  const merged = [];
  for (const entry of entries) {
    const prev = merged[merged.length - 1];
    if (entry.kind === "push" && prev?.kind === "push" && prev.repo === entry.repo) {
      // Same repo pushed repeatedly: keep one line, sum the commit counts when both are known.
      prev.count = prev.count !== null && entry.count !== null ? prev.count + entry.count : null;
      if (!prev.message && entry.message) prev.message = entry.message;
      continue;
    }
    merged.push({ ...entry });
  }
  return merged;
}

async function renderActivity() {
  const events = await api(`/users/${USERNAME}/events?per_page=100`);
  const candidates = [];
  for (const event of events) {
    if (!ACTIVITY_TYPES.has(event.type)) continue;
    if (!(await isPublicRepo(event.repo.name))) continue;
    const entry = await toEntry(event);
    if (entry) candidates.push(entry);
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  const lines = mergeEntries(candidates).slice(0, MAX_LINES).map(renderEntry);
  return lines.length ? lines.join("\n") : "_No recent public activity._";
}

async function getPinnedRepos() {
  if (TOKEN) {
    try {
      const result = await api("", {
        method: "POST",
        graphql: true,
        body: { query: `query { user(login: "${USERNAME}") { pinnedItems(first: 6, types: [REPOSITORY]) { nodes { ... on Repository { nameWithOwner } } } } }` },
      });
      const names = result?.data?.user?.pinnedItems?.nodes?.map((node) => node.nameWithOwner).filter(Boolean);
      if (names?.length) return new Set(names);
    } catch (error) {
      console.warn(`pinned lookup failed (${error.message}), using fallback list`);
    }
  }
  return new Set(PINNED_FALLBACK);
}

async function renderProjects() {
  const [repos, pinned] = await Promise.all([
    api(`/users/${USERNAME}/repos?per_page=100&sort=pushed&direction=desc`),
    getPinnedRepos(),
  ]);
  const cutoff = Date.now() - ACTIVE_DAYS * 24 * 60 * 60 * 1000;
  const rows = repos
    .filter((repo) => !repo.private && !repo.fork && !repo.archived)
    .filter((repo) => new Date(repo.pushed_at).getTime() >= cutoff)
    .filter((repo) => !pinned.has(repo.full_name) && !EXCLUDE_REPOS.has(repo.full_name))
    .filter((repo) => !REQUIRE_DESCRIPTION || oneLine(repo.description))
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
    .slice(0, MAX_PROJECTS)
    .map((repo) => {
      const name = `[**${repo.name}**](${repo.html_url})${repo.stargazers_count > 0 ? ` ⭐ ${repo.stargazers_count}` : ""}`;
      const website = websiteLink(repo.homepage);
      const description = `${truncate(repo.description, 100).replace(/\|/g, "\\|")}${website ? ` · ${website}` : ""}`;
      return `| ${name} | ${description} |`;
    });
  const privateRows = PRIVATE_PROJECTS.map(({ name, description }) => `| **${name}** | ${description} |`);
  const parts = [];
  if (rows.length) parts.push("### Open Source Projects", "", "| Repository | Description |", "| --- | --- |", ...rows);
  if (privateRows.length) parts.push("", "### Private Projects", "", "| Project | Description |", "| --- | --- |", ...privateRows);
  return parts.length ? parts.join("\n") : "_No active public repositories right now._";
}

function replaceSection(markdown, name, body) {
  const block = new RegExp(`<!--START_SECTION:${name}-->[\\s\\S]*?<!--END_SECTION:${name}-->`);
  if (!block.test(markdown)) throw new Error(`marker "${name}" not found in README.md`);
  return markdown.replace(block, `<!--START_SECTION:${name}-->\n${body}\n<!--END_SECTION:${name}-->`);
}

async function main() {
  const readme = await readFile(README_PATH, "utf8");
  const [activity, projects] = await Promise.all([renderActivity(), renderProjects()]);
  const updated = replaceSection(replaceSection(readme, "activity", activity), "projects", projects);
  if (updated === readme) {
    console.log("README already up to date.");
    return;
  }
  await writeFile(README_PATH, updated);
  console.log("README updated.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
