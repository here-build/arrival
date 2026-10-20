// Writes Starlight pages from mounts.mjs. The bytes stay in the source file;
// the page is a view with rewritten links and an edit URL back to that file.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { base, generatedDirs, mounts } from "../mounts.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const contentDir = path.resolve(import.meta.dirname, "../src/content/docs");
const githubBlob = "https://github.com/here-build/arrival/blob/main/";
const githubTree = "https://github.com/here-build/arrival/tree/main/";
const githubEdit = "https://github.com/here-build/arrival/edit/main/";

const bySource = new Map(mounts.map((mount) => [mount.source, mount]));

function sitePath(out) {
  let slug = out.replace(/\.md$/, "");
  if (slug.endsWith("/index")) slug = slug.slice(0, -"/index".length);
  if (slug === "index" || slug === "") return `${base}/`;
  return `${base}/${slug}/`;
}

function stripH1(markdown) {
  const match = /^#\s+(.+)\r?\n/.exec(markdown);
  if (!match) return { title: "", body: markdown };
  const title = match[1].replace(/\s+#+\s*$/, "").trim();
  let body = markdown.slice(match[0].length);
  if (body.startsWith("\n")) body = body.slice(1);
  return { title, body };
}

function plain(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function describe(body, title) {
  const lines = body.split("\n");
  const buf = [];
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!started) {
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      if (/^(```|~~~|\||[-*]\s|\d+\.\s)/.test(trimmed)) break;
      started = true;
    } else if (trimmed === "") {
      break;
    }
    buf.push(trimmed.replace(/^>\s?/, ""));
  }
  let text = plain(buf.join(" "));
  if (text.length > 180) {
    const cut = text.slice(0, 177);
    const word = cut.replace(/\s+\S*$/, "");
    text = `${word || cut}…`;
  }
  return text || title;
}

function isDir(repoPath) {
  const abs = path.join(repoRoot, repoPath);
  return fs.existsSync(abs) && fs.statSync(abs).isDirectory();
}

function isFile(repoPath) {
  const abs = path.join(repoRoot, repoPath);
  return fs.existsSync(abs) && fs.statSync(abs).isFile();
}

function rewriteTarget(raw, fromFile) {
  let url = raw.trim();
  if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1);
  if (url.startsWith("#")) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return raw;

  const hashAt = url.indexOf("#");
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const pathPart = hashAt === -1 ? url : url.slice(0, hashAt);
  if (!pathPart) return raw;

  let decoded = pathPart;
  try {
    decoded = decodeURI(pathPart);
  } catch {
    return raw;
  }
  const abs = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), decoded)).replace(/\/$/, "");
  if (abs.startsWith("..") || abs.startsWith("/")) return raw;

  const mounted = bySource.get(abs);
  if (mounted) return sitePath(mounted.out) + hash;

  const readme = bySource.get(`${abs}/README.md`);
  if (readme && isDir(abs)) return sitePath(readme.out) + hash;

  if (isFile(abs)) return githubBlob + encodeURI(abs) + hash;
  if (isDir(abs)) return githubTree + encodeURI(abs) + hash;
  return raw;
}

function maskCode(markdown) {
  const chunks = [];
  let out = "";
  let i = 0;
  const atLineStart = (index) => index === 0 || markdown[index - 1] === "\n";

  while (i < markdown.length) {
    if ((markdown.startsWith("```", i) || markdown.startsWith("~~~", i)) && atLineStart(i)) {
      const fence = markdown.startsWith("```", i) ? "```" : "~~~";
      const close = markdown.indexOf(`\n${fence}`, i + fence.length);
      const end = close === -1 ? markdown.length : close + 1 + fence.length;
      chunks.push(markdown.slice(i, end));
      out += `\u0000${chunks.length - 1}\u0000`;
      i = end;
      continue;
    }
    if (markdown[i] === "`") {
      let width = 0;
      while (markdown[i + width] === "`") width += 1;
      const closer = markdown.indexOf("`".repeat(width), i + width);
      if (closer !== -1) {
        const end = closer + width;
        chunks.push(markdown.slice(i, end));
        out += `\u0000${chunks.length - 1}\u0000`;
        i = end;
        continue;
      }
    }
    out += markdown[i];
    i += 1;
  }
  return { text: out, chunks };
}

function unmask(text, chunks) {
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => chunks[Number(index)]);
}

function rewriteLinks(markdown, fromFile) {
  const masked = maskCode(markdown);
  const linked = masked.text
    .replace(/(!?\[[^\]\n]*\])\((<[^>\n]+>|[^)\s]+)(\s+"[^"\n]*")?\)/g, (whole, label, target, title = "") => {
      const next = rewriteTarget(target, fromFile);
      return next === target.trim() || next === target ? whole : `${label}(${next}${title})`;
    })
    .replace(/^(\[[^\]\n]+\]:)[ \t]+(<?\S+>?)(.*)$/gm, (whole, name, target, rest) => {
      const next = rewriteTarget(target, fromFile);
      return next === target ? whole : `${name} ${next}${rest}`;
    });
  return unmask(linked, masked.chunks);
}

function render(mount) {
  const abs = path.join(repoRoot, mount.source);
  const markdown = fs.readFileSync(abs, "utf8");
  const { title, body } = stripH1(markdown);
  const pageTitle = title || mount.label;
  const description = describe(body, pageTitle);
  const linked = rewriteLinks(body, mount.source);
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(pageTitle)}`,
    `description: ${JSON.stringify(description)}`,
    `editUrl: ${JSON.stringify(githubEdit + mount.source)}`,
    "sidebar:",
    `  label: ${JSON.stringify(mount.label)}`,
    `  order: ${mount.order}`,
    "---",
    "",
    `<!-- Generated from ${mount.source}. Edit that file. -->`,
    "",
    linked.endsWith("\n") ? linked : `${linked}\n`,
  ].join("\n");
  return { out: mount.out, text: frontmatter };
}

function walkMd(dir, into = []) {
  if (!fs.existsSync(dir)) return into;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMd(abs, into);
    else if (entry.name.endsWith(".md")) into.push(abs);
  }
  return into;
}

export function mountSources() {
  return mounts.map((mount) => path.join(repoRoot, mount.source));
}

export function mountAll() {
  const seenOut = new Set();
  const seenSource = new Set();
  for (const mount of mounts) {
    if (seenOut.has(mount.out)) throw new Error(`duplicate docs output ${mount.out}`);
    if (seenSource.has(mount.source)) throw new Error(`duplicate docs source ${mount.source}`);
    seenOut.add(mount.out);
    seenSource.add(mount.source);
    if (!fs.existsSync(path.join(repoRoot, mount.source))) {
      throw new Error(`missing docs source ${mount.source}`);
    }
  }

  const pages = mounts.map(render);
  const expected = new Map(pages.map((page) => [page.out, page.text]));

  for (const dir of generatedDirs) {
    for (const file of walkMd(path.join(contentDir, dir))) {
      const rel = path.relative(contentDir, file).split(path.sep).join("/");
      if (!expected.has(rel)) fs.rmSync(file);
    }
  }

  let wrote = 0;
  for (const [rel, text] of expected) {
    const abs = path.join(contentDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const prev = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    if (prev !== text) {
      fs.writeFileSync(abs, text);
      wrote += 1;
    }
  }
  return wrote;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const wrote = mountAll();
  console.log(`mounted ${mounts.length} documentation pages (${wrote} written)`);
}
