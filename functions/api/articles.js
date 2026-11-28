import { sanitizeRichHtml } from "../_shared/sanitize-rich-html.js";

const OWNER = "yanglp1987-a11y";
const REPO = "muyi-zhai";
const ARTICLE_PATH = "src/content/articles";

const MAX_BODY_SIZE = 110000;
const GITHUB_PAGE_SIZE = 100;
const GITHUB_MAX_PAGES = 10;

// GitHub 读写分支必须由当前环境显式配置。绝不回退到 main：
// 未配置、格式异常或与环境分支不一致时返回 null，由调用方安全失败。
function getWriteBranch(env) {
  const value = typeof env?.GITHUB_WRITE_BRANCH === "string"
    ? env.GITHUB_WRITE_BRANCH.trim()
    : "";
  if (!value) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(value) ||
      value.includes("..") || value.includes("//")) {
    return null;
  }
  // CF_PAGES_BRANCH 在 Pages 构建阶段注入；若运行时可用，必须与之匹配。
  const pagesBranch = env.CF_PAGES_BRANCH;
  if (typeof pagesBranch === "string" && pagesBranch.trim() &&
      pagesBranch.trim() !== value) {
    return null;
  }
  return value;
}

function invalidBranchResponse() {
  return json({ success: false, message: "服务器分支配置异常" }, 503);
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function validOrigin(request) {
  const origin = request.headers.get("Origin");

  if (!origin && request.method === "GET") return true;
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function getAdminSession(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(
    /(?:^|;\s*)muyi_session=([a-f0-9]{64})(?:;|$)/
  );

  if (!match || !env.AUTH_CODES || !env.ADMIN_EMAIL) {
    return false;
  }

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(match[1])
  );

  const hash = Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");

  const email = await env.AUTH_CODES.get(`session:${hash}`);

  return email === env.ADMIN_EMAIL.trim().toLowerCase();
}

async function authorize(request, env) {
  if (!validOrigin(request)) return false;
  return await getAdminSession(request, env);
}

function isJsonRequest(request) {
  const contentType = request.headers.get("Content-Type") || "";

  return /^application\/json(?:\s*;|$)/i.test(contentType.trim());
}

// 流式读取请求体，超过限制立即停止读取
async function readBody(request) {
  const contentLength = request.headers.get("Content-Length");

  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return null;
    if (Number(contentLength) > MAX_BODY_SIZE) return null;
  }

  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks = [];
  let totalSize = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      totalSize += value.byteLength;

      if (totalSize > MAX_BODY_SIZE) {
        await reader.cancel();
        return null;
      }

      chunks.push(value);
    }

    const bytes = new Uint8Array(totalSize);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const text = new TextDecoder("utf-8", {
      fatal: true
    }).decode(bytes);

    const body = JSON.parse(text);

    return body &&
      typeof body === "object" &&
      !Array.isArray(body)
      ? body
      : null;

  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

async function githubRequest(env, branch, path, options = {}) {
  if (!env.GITHUB_TOKEN) {
    throw new Error("GitHub token not configured");
  }

  const method = (options.method || "GET").toUpperCase();
  const url = new URL(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`);
  // 所有读取都必须显式指定分支，避免落到仓库默认分支 main。
  if (method === "GET" && branch) url.searchParams.set("ref", branch);

  return await fetch(
    url.toString(),
    {
      ...options,
      headers: {
        "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "muyi-zhai-admin",
        "Content-Type": "application/json",
        ...options.headers
      }
    }
  );
}

function validSlug(slug) {
  return typeof slug === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

function safeText(value, maxLength) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength;
}

function validDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function validArticle(article) {
  return article &&
    validSlug(article.slug) &&
    safeText(article.title, 120) &&
    safeText(article.description, 300) &&
    safeText(article.category, 50) &&
    validDate(article.pubDate) &&
    typeof article.content === "string" &&
    article.content.trim().length > 0 &&
    article.content.length <= 100000;
}

function createMarkdown(article) {
  const safe = value => JSON.stringify(value);
  const format = article.contentFormat === "html" ? "html" : "markdown";
  return `---
title: ${safe(article.title.trim())}
description: ${safe(article.description.trim())}
pubDate: ${safe(article.pubDate)}
category: ${safe(article.category.trim())}
contentFormat: ${safe(format)}
draft: false
---

${article.content.trim()}
`;
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}

function decodeBase64(base64) {
  const binary = atob(base64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(
    binary,
    character => character.charCodeAt(0)
  );

  return new TextDecoder().decode(bytes);
}

// 读取已发布文章列表，支持最多 1000 个目录条目
async function getArticleList(env, branch) {
  const articles = [];

  for (let page = 1; page <= GITHUB_MAX_PAGES; page++) {
    const query = `?per_page=${GITHUB_PAGE_SIZE}&page=${page}`;

    const response = await githubRequest(
      env,
      branch,
      `${ARTICLE_PATH}${query}`
    );

    if (!response.ok) {
      return {
        success: false,
        status: response.status
      };
    }

    const files = await response.json();

    if (!Array.isArray(files)) {
      return {
        success: false,
        status: 502
      };
    }

    const pageArticles = files
      .filter(file =>
        file.type === "file" &&
        typeof file.name === "string" &&
        file.name.endsWith(".md")
      )
      .map(file => ({
        slug: file.name.replace(/\.md$/, ""),
        name: file.name,
        path: file.path,
        sha: file.sha
      }));

    articles.push(...pageArticles);

    if (files.length < GITHUB_PAGE_SIZE) {
      return {
        success: true,
        articles
      };
    }
  }

  // 第 10 页仍然满载，说明可能超过 Contents API 的目录读取上限
  return {
    success: false,
    status: 413
  };
}

// 读取已发布文章列表，或读取某一篇文章的完整 Markdown
export async function onRequestGet({ request, env }) {
  try {
    if (!(await authorize(request, env))) {
      return json(
        { success: false, message: "请先登录" },
        401
      );
    }

    const branch = getWriteBranch(env);
    if (!branch) return invalidBranchResponse();

    const url = new URL(request.url);
    const slug = url.searchParams.get("slug");

    if (slug !== null) {
      if (!validSlug(slug)) {
        return json(
          { success: false, message: "文章标识不正确" },
          400
        );
      }

      const path = `${ARTICLE_PATH}/${slug}.md`;
      const response = await githubRequest(env, branch, path);

      if (response.status === 404) {
        return json(
          { success: false, message: "文章不存在" },
          404
        );
      }

      if (!response.ok) {
        return json(
          { success: false, message: "读取文章失败" },
          502
        );
      }

      const file = await response.json();

      return json({
        success: true,
        article: {
          slug,
          path: file.path,
          sha: file.sha,
          markdown: decodeBase64(file.content || "")
        }
      });
    }

    const result = await getArticleList(env, branch);

    if (!result.success) {
      return json(
        {
          success: false,
          message: result.status === 413
            ? "文章数量超过当前接口支持的范围"
            : "读取文章列表失败"
        },
        result.status === 413 ? 413 : 502
      );
    }

    return json({
      success: true,
      articles: result.articles
    });

  } catch {
    return json(
      { success: false, message: "服务器暂时无法处理请求" },
      500
    );
  }
}

// 新建或修改已发布文章
export async function onRequestPost({ request, env }) {
  let stage = "authorize";
  try {
    if (!(await authorize(request, env))) {
      return json(
        { success: false, message: "请先登录" },
        401
      );
    }

    const branch = getWriteBranch(env);
    if (!branch) return invalidBranchResponse();

    stage = "validate-content-type";
    if (!isJsonRequest(request)) {
      return json(
        { success: false, message: "请求格式不正确" },
        400
      );
    }

    stage = "read-request-body";
    const article = await readBody(request);

    if (!article || !validArticle(article)) {
      return json(
        { success: false, message: "文章信息不完整或格式不正确" },
        400
      );
    }
    if (article.contentFormat !== undefined && !["markdown", "html"].includes(article.contentFormat)) {
      return json({ success: false, message: "正文格式不正确" }, 400);
    }
    if (article.contentFormat === "html") {
      article.content = sanitizeRichHtml(article.content);
      if (!article.content) return json({ success: false, message: "正文内容不符合安全格式" }, 400);
    }

    if (
      article.action !== "create" &&
      article.action !== "update"
    ) {
      return json(
        { success: false, message: "操作类型不正确" },
        400
      );
    }

    const path = `${ARTICLE_PATH}/${article.slug}.md`;

    // 创建时检查文章是否已经存在
    if (article.action === "create") {
      stage = "github-check-existing";
      const existing = await githubRequest(env, branch, path);
      if (!existing.ok && existing.status !== 404) {
        console.error("[articles-api] GitHub existence check failed", {
          status: existing.status
        });
      }

      if (existing.ok) {
        return json(
          {
            success: false,
            message: "这篇文章已经存在，请更换文章标识"
          },
          409
        );
      }

      if (existing.status !== 404) {
        return json(
          {
            success: false,
            message: "检查文章是否存在失败"
          },
          502
        );
      }
    }

    let sha;

    // 修改时取得原文件 SHA
    if (article.action === "update") {
      stage = "github-read-existing";
      const existing = await githubRequest(env, branch, path);

      if (existing.status === 404) {
        return json(
          { success: false, message: "文章不存在，无法修改" },
          404
        );
      }

      if (!existing.ok) {
        console.error("[articles-api] GitHub read existing failed", {
          status: existing.status
        });
        return json(
          { success: false, message: "读取原文章失败" },
          502
        );
      }

      const existingData = await existing.json();
      sha = existingData.sha;

      if (typeof sha !== "string" || !sha) {
        return json(
          { success: false, message: "原文章版本信息不正确" },
          502
        );
      }
    }

    const markdown = createMarkdown(article);
    const encodedContent = encodeBase64(markdown);

    stage = "github-write-article";
    const response = await githubRequest(env, branch, path, {
      method: "PUT",
      body: JSON.stringify({
        message: article.action === "create"
          ? `新增文章：${article.title.trim()}`
          : `修改文章：${article.title.trim()}`,
        content: encodedContent,
        branch,
        ...(sha ? { sha } : {})
      })
    });

    if (!response.ok) {
      console.error("[articles-api] GitHub write failed", {
        status: response.status
      });
    }

    if (response.status === 409 || response.status === 422) {
      return json(
        {
          success: false,
          message: "文章版本或文件状态已发生变化，请刷新后重试"
        },
        409
      );
    }

    if (!response.ok) {
      return json(
        { success: false, message: "保存文章到 GitHub 失败" },
        502
      );
    }

    return json({
      success: true,
      message: "文章已提交，网站将自动更新"
    });

  } catch (error) {
    console.error("[articles-api] POST failed", {
      stage,
      errorName: error instanceof Error ? error.name : "UnknownError"
    });
    return json(
      { success: false, message: "服务器暂时无法处理请求" },
      500
    );
  }
}

// 删除已发布文章
export async function onRequestDelete({ request, env }) {
  try {
    if (!(await authorize(request, env))) {
      return json(
        { success: false, message: "请先登录" },
        401
      );
    }

    const branch = getWriteBranch(env);
    if (!branch) return invalidBranchResponse();

    if (!isJsonRequest(request)) {
      return json(
        { success: false, message: "请求格式不正确" },
        400
      );
    }

    const body = await readBody(request);

    if (!body || !validSlug(body.slug)) {
      return json(
        { success: false, message: "文章标识不正确" },
        400
      );
    }

    const path = `${ARTICLE_PATH}/${body.slug}.md`;
    const existing = await githubRequest(env, branch, path);

    if (existing.status === 404) {
      return json(
        { success: false, message: "文章不存在" },
        404
      );
    }

    if (!existing.ok) {
      return json(
        { success: false, message: "读取文章信息失败" },
        502
      );
    }

    const file = await existing.json();

    if (typeof file.sha !== "string" || !file.sha) {
      return json(
        { success: false, message: "文章版本信息不正确" },
        502
      );
    }

    const response = await githubRequest(env, branch, path, {
      method: "DELETE",
      body: JSON.stringify({
        message: `删除文章：${body.slug}`,
        sha: file.sha,
        branch
      })
    });

    if (response.status === 409 || response.status === 422) {
      return json(
        {
          success: false,
          message: "文章状态已发生变化，请刷新后重试"
        },
        409
      );
    }

    if (!response.ok) {
      return json(
        { success: false, message: "删除文章失败" },
        502
      );
    }

    return json({
      success: true,
      message: "文章已删除，网站将自动更新"
    });

  } catch {
    return json(
      { success: false, message: "服务器暂时无法处理请求" },
      500
    );
  }
}
