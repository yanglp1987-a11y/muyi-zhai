
const MAX_BODY_SIZE = 2048;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
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

function isJsonRequest(request) {
  const contentType = request.headers.get("Content-Type") || "";

  return /^application\/json(?:\s*;|$)/i.test(contentType.trim());
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

async function hashValue(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function safeCompare(a, b) {
  if (
    typeof a !== "string" ||
    typeof b !== "string" ||
    a.length !== b.length
  ) {
    return false;
  }

  let difference = 0;

  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return difference === 0;
}

export async function onRequestPost({ request, env }) {
  let sessionKey = "";
  let sessionCreated = false;

  try {
    // 1. 检查请求来源
    if (!validOrigin(request)) {
      return json(
        { success: false, message: "请求来源不正确" },
        403
      );
    }

    // 2. 检查请求格式
    if (!isJsonRequest(request)) {
      return json(
        { success: false, message: "请求格式不正确" },
        400
      );
    }

    // 3. 检查必要配置
    if (!env.AUTH_CODES || !env.ADMIN_EMAIL) {
      return json(
        { success: false, message: "后台存储尚未配置" },
        500
      );
    }

    const body = await readBody(request);

    if (
      !body ||
      typeof body.email !== "string" ||
      typeof body.code !== "string" ||
      !/^\d{6}$/.test(body.code)
    ) {
      return json(
        { success: false, message: "邮箱或验证码格式不正确" },
        400
      );
    }

    // 4. 检查管理员邮箱
    const adminEmail = env.ADMIN_EMAIL.trim().toLowerCase();
    const email = body.email.trim().toLowerCase();

    if (!adminEmail || email !== adminEmail) {
      return json(
        { success: false, message: "无权登录" },
        403
      );
    }

    // 5. 读取验证码
    const codeKey = `code:${email}`;
    const savedHash = await env.AUTH_CODES.get(codeKey);

    if (!savedHash) {
      return json(
        { success: false, message: "验证码已过期或不存在" },
        400
      );
    }

    // 6. 检查错误尝试次数
    const attemptsKey = `attempts:${email}`;
    const attempts = Number(
      await env.AUTH_CODES.get(attemptsKey) || "0"
    );

    if (!Number.isInteger(attempts) || attempts >= 5) {
      return json(
        { success: false, message: "尝试次数过多，请重新获取验证码" },
        429
      );
    }

    // 7. 验证验证码
    const inputHash = await hashValue(body.code);

    if (!safeCompare(inputHash, savedHash)) {
      await env.AUTH_CODES.put(
        attemptsKey,
        String(attempts + 1),
        { expirationTtl: 600 }
      );

      return json(
        { success: false, message: "验证码错误" },
        400
      );
    }

    // 8. 生成随机登录令牌
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);

    const token = Array.from(randomBytes)
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");

    const tokenHash = await hashValue(token);

    sessionKey = `session:${tokenHash}`;

    // 9. 先创建 Session，有效期 24 小时
    await env.AUTH_CODES.put(
      sessionKey,
      email,
      { expirationTtl: 86400 }
    );

    sessionCreated = true;

    // 10. Session 创建成功后，再清理验证码和错误次数
    try {
      await Promise.all([
        env.AUTH_CODES.delete(codeKey),
        env.AUTH_CODES.delete(attemptsKey),
        env.AUTH_CODES.delete(`rate:${email}`)
      ]);
    } catch {
      // 清理失败时撤销刚创建的 Session
      await env.AUTH_CODES.delete(sessionKey);
      sessionCreated = false;

      return json(
        { success: false, message: "登录处理失败，请重新获取验证码" },
        500
      );
    }

    // 11. 设置安全 Cookie
    return new Response(
      JSON.stringify({
        success: true,
        message: "登录成功"
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Set-Cookie": `muyi_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`
        }
      }
    );

  } catch {
    // 发生异常时，尽力撤销未能正常完成的 Session
    if (sessionCreated && sessionKey) {
      await env.AUTH_CODES.delete(sessionKey).catch(() => {});
    }

    return json(
      { success: false, message: "服务器暂时无法处理请求" },
      500
    );
  }
}
