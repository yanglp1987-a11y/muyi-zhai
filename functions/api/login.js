
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

async function readBody(request) {
  const length = Number(request.headers.get("Content-Length") || 0);

  if (length > MAX_BODY_SIZE) return null;

  try {
    const text = await request.text();

    if (new TextEncoder().encode(text).length > MAX_BODY_SIZE) {
      return null;
    }

    const body = JSON.parse(text);

    return body && typeof body === "object" && !Array.isArray(body)
      ? body
      : null;
  } catch {
    return null;
  }
}

// 使用拒绝采样生成六位数字验证码
function generateCode() {
  const range = 1000000;
  const limit = Math.floor(0x100000000 / range) * range;
  const random = new Uint32Array(1);

  do {
    crypto.getRandomValues(random);
  } while (random[0] >= limit);

  return String(random[0] % range).padStart(6, "0");
}

// 对验证码进行 SHA-256 哈希
async function hashCode(code) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(code)
  );

  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

// 邮件发送失败时只清理验证码，保留发送频率限制
async function cleanupLoginRecords(env, email) {
  if (!env.AUTH_CODES) return;

  await Promise.allSettled([
    env.AUTH_CODES.delete(`code:${email}`)
  ]);
}

export async function onRequestPost({ request, env }) {
  let email = "";
  let rateLimitKey = "";

  try {
    // 1. 检查请求来源
    if (!validOrigin(request)) {
      return json(
        { success: false, message: "请求来源不正确" },
        403
      );
    }

    // 2. 检查请求格式
    if (
      !request.headers.get("Content-Type")
        ?.toLowerCase()
        .includes("application/json")
    ) {
      return json(
        { success: false, message: "请求格式不正确" },
        400
      );
    }

    // 3. 检查必要配置
    if (
      !env.AUTH_CODES ||
      !env.ADMIN_EMAIL ||
      !env.RESEND_API_KEY
    ) {
      return json(
        { success: false, message: "服务器配置不完整" },
        500
      );
    }

    // 4. 读取并验证邮箱
    const body = await readBody(request);

    if (!body || typeof body.email !== "string") {
      return json(
        { success: false, message: "邮箱格式不正确" },
        400
      );
    }

    email = body.email.trim().toLowerCase();

    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return json(
        { success: false, message: "邮箱格式不正确" },
        400
      );
    }

    // 5. 只允许管理员邮箱登录
    if (email !== env.ADMIN_EMAIL.trim().toLowerCase()) {
      return json(
        { success: false, message: "无权登录" },
        403
      );
    }

    // 6. 检查发送频率
    rateLimitKey = `rate:${email}`;

    const rateLimited = await env.AUTH_CODES.get(rateLimitKey);

    if (rateLimited) {
      return json(
        { success: false, message: "操作过于频繁，请稍后再试" },
        429
      );
    }

    await env.AUTH_CODES.put(
      rateLimitKey,
      "1",
      { expirationTtl: 60 }
    );

    // 7. 生成验证码并保存哈希
    const code = generateCode();
    const codeHash = await hashCode(code);

    await env.AUTH_CODES.put(
      `code:${email}`,
      codeHash,
      { expirationTtl: 600 }
    );

    // 8. 通过 Resend 发送验证码
    let response;

    try {
      response = await fetch(
        "https://api.resend.com/emails",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: "木易斋 <onboarding@resend.dev>",
            to: [email],
            subject: "木易斋后台登录验证码",
            html: `
              <div style="font-family: sans-serif; line-height: 1.8;">
                <h2>木易斋后台登录</h2>
                <p>你的登录验证码是：</p>
                <h1 style="letter-spacing: 8px;">${code}</h1>
                <p>验证码有效期为 10 分钟，请勿泄露给他人。</p>
              </div>
            `
          })
        }
      );
    } catch {
      await cleanupLoginRecords(env, email);

      return json(
        { success: false, message: "邮件发送失败，请稍后重试" },
        502
      );
    }

    // 9. 处理邮件服务返回的失败结果
    if (!response.ok) {
      await cleanupLoginRecords(env, email);

      return json(
        { success: false, message: "邮件发送失败，请稍后重试" },
        502
      );
    }

    // 10. 发送成功，清除之前的错误尝试次数
    await env.AUTH_CODES.delete(`attempts:${email}`);

    return json({
      success: true,
      message: "验证码已发送，请检查邮箱"
    });

  } catch {
    // 其他异常发生时，尽力清理验证码
    if (email && rateLimitKey) {
      await cleanupLoginRecords(env, email);
    }

    return json(
      { success: false, message: "服务器暂时无法处理请求" },
      500
    );
  }
}
