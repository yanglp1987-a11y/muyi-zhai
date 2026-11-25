const OWNER = "yanglp1987-a11y";
const REPO = "muyi-zhai";
const BRANCH = "main";
const IMAGE_PATH = "public/images/articles";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = 7 * 1024 * 1024;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function validOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function isAdmin(request, env) {
  if (!validOrigin(request)) return false;
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)muyi_session=([a-f0-9]{64})(?:;|$)/);
  if (!match || !env.AUTH_CODES || !env.ADMIN_EMAIL) return false;

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

function decodeBase64(value) {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) {
    return null;
  }
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function detectImage(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: "jpg", type: "image/jpeg" };
  }
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
      bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a &&
      bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { ext: "png", type: "image/png" };
  }
  if (bytes.length >= 6) {
    const signature = new TextDecoder().decode(bytes.slice(0, 6));
    if (signature === "GIF87a" || signature === "GIF89a") {
      return { ext: "gif", type: "image/gif" };
    }
  }
  if (bytes.length >= 12 &&
      new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") {
    return { ext: "webp", type: "image/webp" };
  }
  return null;
}

export async function onRequestPost({ request, env }) {
  try {
    if (!(await isAdmin(request, env))) {
      return json({ success: false, message: "请先登录" }, 401);
    }

    const contentType = request.headers.get("Content-Type") || "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      return json({ success: false, message: "请求格式不正确" }, 400);
    }

    const length = Number(request.headers.get("Content-Length") || 0);
    if (length > MAX_REQUEST_BYTES) {
      return json({ success: false, message: "图片不能超过 5MB" }, 413);
    }

    const body = await request.json();
    const bytes = decodeBase64(body?.image);
    if (!bytes || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
      return json({ success: false, message: "图片无效或超过 5MB" }, 400);
    }

    const image = detectImage(bytes);
    if (!image) {
      return json({ success: false, message: "仅支持 JPG、PNG、GIF、WebP 图片" }, 415);
    }

    if (!env.GITHUB_TOKEN) {
      return json({ success: false, message: "图片服务暂不可用" }, 503);
    }

    const filename = `${crypto.randomUUID()}.${image.ext}`;
    const path = `${IMAGE_PATH}/${filename}`;
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const encoded = btoa(binary);

    const response = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`,
      {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "muyi-zhai-admin",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: "上传文章图片",
          content: encoded,
          branch: BRANCH
        })
      }
    );

    if (!response.ok) {
      console.error("[image-upload] GitHub upload failed", { status: response.status });
      return json({ success: false, message: "图片上传失败，请稍后重试" }, 502);
    }

    return json({
      success: true,
      url: `/${path}`,
      message: "图片上传成功"
    });
  } catch (error) {
    console.error("[image-upload] Request failed", {
      errorName: error instanceof Error ? error.name : "UnknownError"
    });
    return json({ success: false, message: "图片上传失败，请稍后重试" }, 500);
  }
}
