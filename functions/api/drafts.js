import { sanitizeRichHtml } from "../_shared/sanitize-rich-html.js";

const DRAFT_PREFIX = "draft:";
const MAX_BODY_SIZE = 110000;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function validSlug(slug) {
  return typeof slug === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

function validDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

function validArticle(article) {
  return article &&
    validSlug(article.slug) &&
    typeof article.title === "string" &&
    article.title.trim().length > 0 &&
    article.title.length <= 120 &&
    typeof article.description === "string" &&
    article.description.trim().length > 0 &&
    article.description.length <= 300 &&
    typeof article.category === "string" &&
    article.category.trim().length > 0 &&
    article.category.length <= 50 &&
    validDate(article.pubDate) &&
    typeof article.content === "string" &&
    article.content.length <= 100000;
}

function validOrigin(request) {
  const origin = request.headers.get("Origin");

  if (!origin && request.method === "GET") {
    return true;
  }

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

async function readBody(request) {
  const reader = request.body?.getReader();

  if (!reader) return null;

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

    const data = new Uint8Array(totalSize);
    let offset = 0;

    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const text = new TextDecoder("utf-8", {
      fatal: true
    }).decode(data);

    const body = JSON.parse(text);

    return body && typeof body === "object" && !Array.isArray(body)
      ? body
      : null;

  } catch {
    return null;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 忽略释放锁时的异常
    }
  }
}

function isJsonRequest(request) {
  const contentType = request.headers.get("Content-Type") || "";

  return /^application\/json(?:\s*;|$)/i.test(contentType.trim());
}

// 读取草稿列表或单篇草稿
export async function onRequestGet({ request, env }) {
  try {
    if (!(await authorize(request, env))) {
      return json(
        { success: false, message: "请先登录" },
        401
      );
    }

    if (!env.ARTICLE_DRAFTS) {
      return json(
        { success: false, message: "草稿存储尚未配置" },
        500
      );
    }

    const url = new URL(request.url);
    const slug = url.searchParams.get("slug");

    if (slug !== null) {
      if (!validSlug(slug)) {
        return json(
          { success: false, message: "草稿标识不正确" },
          400
        );
      }

      const value = await env.ARTICLE_DRAFTS.get(
        `${DRAFT_PREFIX}${slug}`
      );

      if (!value) {
        return json(
          { success: false, message: "草稿不存在" },
          404
        );
      }

      let draft;

      try {
        draft = JSON.parse(value);
      } catch {
        return json(
          { success: false, message: "草稿数据损坏，无法读取" },
          500
        );
      }

      if (!draft || draft.slug !== slug) {
        return json(
          { success: false, message: "草稿数据格式不正确" },
          500
        );
      }

      return json({
        success: true,
        draft
      });
    }

    const drafts = [];
    let cursor;

    do {
      const options = {
        prefix: DRAFT_PREFIX,
        limit: 1000
      };

      if (cursor) {
        options.cursor = cursor;
      }

      const result = await env.ARTICLE_DRAFTS.list(options);

      for (const key of result.keys) {
        const value = await env.ARTICLE_DRAFTS.get(key.name);

        if (!value) continue;

        try {
          const article = JSON.parse(value);

          if (!article || !validSlug(article.slug)) continue;

          drafts.push({
            slug: article.slug,
            title: article.title,
            category: article.category,
            pubDate: article.pubDate,
            updatedAt: article.updatedAt
          });
        } catch {
          // 跳过无法解析的草稿
        }
      }

      cursor = result.list_complete ? null : result.cursor;

    } while (cursor);

    drafts.sort((a, b) =>
      String(b.updatedAt || "").localeCompare(
        String(a.updatedAt || "")
      )
    );

    return json({
      success: true,
      drafts
    });

  } catch {
    return json(
      { success: false, message: "读取草稿失败" },
      500
    );
  }
}

// 保存新草稿或修改已有草稿
export async function onRequestPost({ request, env }) {
  try {
    if (!(await authorize(request, env))) {
      return json(
        { success: false, message: "请先登录" },
        401
      );
    }

    if (!env.ARTICLE_DRAFTS) {
      return json(
        { success: false, message: "草稿存储尚未配置" },
        500
      );
    }

    if (!isJsonRequest(request)) {
      return json(
        { success: false, message: "请求格式不正确" },
        400
      );
    }

    const article = await readBody(request);

    if (!validArticle(article)) {
      return json(
        { success: false, message: "文章信息校验失败" },
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

    const draft = {
      slug: article.slug,
      title: article.title.trim(),
      description: article.description.trim(),
      category: article.category.trim(),
      pubDate: article.pubDate,
      content: article.content,
      contentFormat: article.contentFormat === "html" ? "html" : "markdown",
      updatedAt: new Date().toISOString()
    };

    await env.ARTICLE_DRAFTS.put(
      `${DRAFT_PREFIX}${article.slug}`,
      JSON.stringify(draft)
    );

    return json({
      success: true,
      message: "草稿保存成功"
    });

  } catch {
    return json(
      { success: false, message: "保存草稿失败" },
      500
    );
  }
}

// 删除草稿
export async function onRequestDelete({ request, env }) {
  try {
    if (!(await authorize(request, env))) {
      return json(
        { success: false, message: "请先登录" },
        401
      );
    }

    if (!env.ARTICLE_DRAFTS) {
      return json(
        { success: false, message: "草稿存储尚未配置" },
        500
      );
    }

    if (!isJsonRequest(request)) {
      return json(
        { success: false, message: "请求格式不正确" },
        400
      );
    }

    const body = await readBody(request);

    if (!body || !validSlug(body.slug)) {
      return json(
        { success: false, message: "草稿标识不正确" },
        400
      );
    }

    const key = `${DRAFT_PREFIX}${body.slug}`;
    const existing = await env.ARTICLE_DRAFTS.get(key);

    if (!existing) {
      return json(
        { success: false, message: "草稿不存在" },
        404
      );
    }

    await env.ARTICLE_DRAFTS.delete(key);

    return json({
      success: true,
      message: "草稿已删除"
    });

  } catch {
    return json(
      { success: false, message: "删除草稿失败" },
      500
    );
  }
}
