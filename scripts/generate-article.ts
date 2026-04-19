import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LAST_CATEGORY_FILE = join(__dirname, ".last-category");
const PROMPT_FILE = join(__dirname, "prompts", "article.md");
const BLOGS_DIR = join(ROOT, "src", "content", "blogs");

const CATEGORIES = [
  "backend:ruby-on-rails",
  "backend:nestjs",
  "backend:microservices",
  "backend:ddd",
  "frontend",
  "production-engineering",
  "experience-story",
];

interface Issue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
}

function gh(args: string): string {
  return execSync(`gh ${args}`, { encoding: "utf-8", cwd: ROOT }).trim();
}

function getLastCategory(): string | null {
  if (existsSync(LAST_CATEGORY_FILE)) {
    return readFileSync(LAST_CATEGORY_FILE, "utf-8").trim();
  }
  return null;
}

function saveLastCategory(category: string): void {
  writeFileSync(LAST_CATEGORY_FILE, category + "\n");
}

function getNextCategory(): string {
  const last = getLastCategory();
  if (!last) return CATEGORIES[0];
  const idx = CATEGORIES.indexOf(last);
  return CATEGORIES[(idx + 1) % CATEGORIES.length];
}

function fetchPendingIssues(category: string): Issue[] {
  const json = gh(
    `issue list --label "blog-post,pending,${category}" --state open --json number,title,body,labels --limit 50 -S "sort:created-asc"`
  );
  return JSON.parse(json) as Issue[];
}

function fetchPriorityIssue(): Issue | null {
  try {
    const json = gh(
      `issue list --label "blog-post,pending,priority" --state open --json number,title,body,labels --limit 1 -S "sort:created-asc"`
    );
    const issues = JSON.parse(json) as Issue[];
    return issues.length > 0 ? issues[0] : null;
  } catch {
    return null;
  }
}

function pickIssue(): { issue: Issue; category: string } | null {
  const priority = fetchPriorityIssue();
  if (priority) {
    const cat =
      priority.labels
        .map((l) => l.name)
        .find((n) => CATEGORIES.includes(n)) || "unknown";
    return { issue: priority, category: cat };
  }

  const startCategory = getNextCategory();
  let idx = CATEGORIES.indexOf(startCategory);

  for (let i = 0; i < CATEGORIES.length; i++) {
    const cat = CATEGORIES[(idx + i) % CATEGORIES.length];
    const issues = fetchPendingIssues(cat);
    if (issues.length > 0) {
      return { issue: issues[0], category: cat };
    }
  }

  return null;
}

function slugify(title: string): string {
  return title
    .replace(/^\[.*?\]\s*/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function randomDate(): string {
  const start = new Date("2022-01-01").getTime();
  const end = new Date("2025-12-31").getTime();
  const rand = new Date(start + Math.random() * (end - start));
  return rand.toISOString().split("T")[0];
}

async function generateArticle(issue: Issue): Promise<string> {
  const systemPrompt = readFileSync(PROMPT_FILE, "utf-8");
  const cleanTitle = issue.title.replace(/^\[.*?\]\s*/, "");
  const datetime = randomDate();

  const userPrompt = [
    `Write a blog article with the following details:`,
    ``,
    `**Title:** ${cleanTitle}`,
    `**Date to use in frontmatter:** ${datetime}`,
    issue.body
      ? `**Additional context / notes:**\n${issue.body}`
      : "",
    ``,
    `Generate the complete MDX file now.`,
  ]
    .filter(Boolean)
    .join("\n");

  const { text } = await generateText({
    model: openai("gpt-4o"),
    system: systemPrompt,
    prompt: userPrompt,
    maxOutputTokens: 8192,
  });

  let content = text.trim();
  if (content.startsWith("```")) {
    content = content.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
  }

  return content;
}

async function main() {
  const issueArg = process.argv.find((a) => a.startsWith("--issue="));
  let issue: Issue;
  let category: string;

  if (issueArg) {
    const num = issueArg.split("=")[1];
    const json = gh(
      `issue view ${num} --json number,title,body,labels`
    );
    issue = JSON.parse(json) as Issue;
    category =
      issue.labels.map((l) => l.name).find((n) => CATEGORIES.includes(n)) ||
      "unknown";
  } else {
    const result = pickIssue();
    if (!result) {
      console.log("No pending issues found. Exiting.");
      process.exit(0);
    }
    issue = result.issue;
    category = result.category;
  }

  console.log(`Selected issue #${issue.number}: ${issue.title}`);
  console.log(`Category: ${category}`);

  gh(
    `issue edit ${issue.number} --remove-label "pending" --add-label "in-progress"`
  );
  console.log("Label updated: pending → in-progress");

  console.log("Generating article with Gemini...");
  const content = await generateArticle(issue);

  const slug = slugify(issue.title);
  const filePath = join(BLOGS_DIR, `${slug}.mdx`);
  writeFileSync(filePath, content + "\n");
  console.log(`Article written to: ${filePath}`);

  saveLastCategory(category);
  console.log(`Last category saved: ${category}`);

  console.log(
    JSON.stringify({ issueNumber: issue.number, slug, title: issue.title })
  );
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
