const OWNER = "yanglp1987-a11y";
const REPO = "muyi-zhai";
const BRANCH = "main";
const IMAGE_PATH = "public/images/articles";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const CACHE_MAX_AGE = 31536000;

const FILENAME_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(?:png|jpe?g|gif|webp)$/i;
const CONTENT_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", ...extraHeaders },
  });
}

function contentTypeFor(filename) {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

function etagFor(filename) {
  return `W/"${filename}"`;
}

function makeCacheKey(request) {
  const url = new URL(request.url);
  url.search = "";
  return new Request(url.toString(), { method: "GET", headers: { Accept: "image/*" } });
}

// Rate-limit responses must never be cached; Retry-After is normalized to
// delta-seconds so a malformed upstream value cannot reach the client.
// Date.parse is deliberately gated by a strict IMF-fixdate pattern because it
// fuzzy-parses garbage (e.g. 'abc;evil="1"' -> year 2001).
const HTTP_DATE_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

function normalizeRetryAfter(value) {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{1,10}$/.test(trimmed)) return trimmed;
  if (!HTTP_DATE_RE.test(trimmed)) return null;
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return null;
  const seconds = Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
  return String(seconds);
}

// GitHub uses 403 both for rate limiting and for permission problems, so the
// status alone is ambiguous. Signals are checked in order of reliability and
// upstream content is only inspected for classification, never forwarded.
async function isRateLimited(upstream) {
  if (upstream.headers.get("x-ratelimit-remaining") === "0") return true;
  if (upstream.headers.get("Retry-After")) return true;

  const declaredLength = Number(upstream.headers.get("Content-Length") || 0);
  if (declaredLength > 64 * 1024) return false;

  try {
    const text = await upstream.text();
    return /rate limit|secondary rate|abuse detection/i.test(text.slice(0, 4096));
  } catch {
    return false;
  }
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const method = (request.method || "GET").toUpperCase();

  if (method !== "GET" && method !== "HEAD") {
    return json({ error: "Method not allowed" }, 405, { Allow: "GET, HEAD" });
  }

  const filename = params?.filename;
  if (typeof filename !== "string" || !FILENAME_RE.test(filename)) {
    return json({ error: "Invalid image filename" }, 400);
  }

  const etag = etagFor(filename);
  const cache = globalThis.caches?.default;

  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch && ifNoneMatch.split(",").some(tag => tag.trim() === etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": `public, max-age=${CACHE_MAX_AGE}, immutable`,
      },
    });
  }

  if (cache) {
    try {
      const cached = await cache.match(makeCacheKey(request));
      if (cached) {
        const headers = new Headers(cached.headers);
        headers.set("X-Image-Proxy-Cache", "HIT");
        if (method === "HEAD") return new Response(null, { status: 200, headers });
        return new Response(cached.body, { status: 200, headers });
      }
    } catch {
      // Cache API unavailable: fall through to GitHub.
    }
  }

  if (!env.GITHUB_TOKEN) {
    return json({ error: "图片服务暂不可用" }, 503);
  }

  const upstreamUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${IMAGE_PATH}/${filename}?ref=${encodeURIComponent(BRANCH)}`;

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        "Accept": "application/vnd.github.raw+json",
        "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "muyi-zhai-image-proxy",
      },
    });
  } catch (error) {
    console.error("[image-proxy] GitHub request failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return json({ error: "图片源暂时不可用" }, 502);
  }

  if (upstream.status === 404) {
    return json({ error: "图片不存在" }, 404);
  }

  if (upstream.status === 401) {
    // Credential is rejected upstream: a server-side configuration problem,
    // not a client error. The token value and GitHub's body never leave here.
    console.error("[image-proxy] GitHub rejected credentials", { status: 401 });
    return json({ error: "图片服务配置异常" }, 503);
  }

  if (upstream.status === 403 || upstream.status === 429) {
    if (upstream.status === 429 || await isRateLimited(upstream)) {
      const retryAfter = normalizeRetryAfter(upstream.headers.get("Retry-After")) || "60";
      console.error("[image-proxy] GitHub rate limited", { status: upstream.status, retryAfter });
      return json({ error: "图片源访问受限，请稍后重试" }, 429, { "Retry-After": retryAfter });
    }
    console.error("[image-proxy] GitHub denied access", { status: upstream.status });
    return json({ error: "图片服务配置异常" }, 503);
  }

  if (!upstream.ok) {
    console.error("[image-proxy] GitHub returned error", { status: upstream.status });
    return json({ error: "图片源返回错误" }, 502);
  }

  const declaredLength = Number(upstream.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_IMAGE_BYTES) {
    try { await upstream.body?.cancel(); } catch { /* ignore */ }
    return json({ error: "图片超过 5MB" }, 413);
  }

  const headers = new Headers({
    "Content-Type": contentTypeFor(filename),
    "Cache-Control": `public, max-age=${CACHE_MAX_AGE}, immutable`,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "X-Image-Proxy-Cache": "MISS",
  });
  if (declaredLength > 0) headers.set("Content-Length", String(declaredLength));

  if (method === "HEAD") {
    try { await upstream.body?.cancel(); } catch { /* ignore */ }
    return new Response(null, { status: 200, headers });
  }

  if (!upstream.body) {
    // A 200 with no body must never be served (or cached) as a valid image.
    return json({ error: "图片源返回空内容" }, 502);
  }

  // Manual pump instead of pipeThrough: the size guard needs to cancel the
  // upstream reader cleanly. Erroring a TransformStream while the source is
  // still writing leaves an unhandled rejection behind.
  const reader = upstream.body.getReader();
  let streamed = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        controller.error(new Error("Upstream read failed"));
        return;
      }
      if (chunk.done) {
        controller.close();
        return;
      }
      streamed += chunk.value.byteLength;
      if (streamed > MAX_IMAGE_BYTES) {
        try { await reader.cancel(); } catch { /* ignore */ }
        console.error("[image-proxy] image exceeded 5MB while streaming", { filename });
        try { controller.error(new Error("Image exceeds 5MB")); } catch { /* already closed */ }
        return;
      }
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      try { return reader.cancel(reason); } catch { return undefined; }
    },
  });

  const response = new Response(stream, { status: 200, headers });

  if (cache) {
    try {
      // Caching is best-effort. A rejected put (e.g. the stream aborted at the
      // 5MB guard) must not surface as an unhandled rejection, and a partial
      // body must never be stored.
      context.waitUntil?.(
        Promise.resolve(cache.put(makeCacheKey(request), response.clone())).catch(() => {}),
      );
    } catch {
      // Cache API unavailable: never break the image response.
    }
  }

  return response;
}
