
async function getSessionToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(
    /(?:^|;\s*)muyi_session=([a-f0-9]{64})(?:;|$)/
  );

  return match ? match[1] : null;
}

async function hashToken(token) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );

  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

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

async function isLoggedIn(request, env) {
  if (!env.AUTH_CODES || !env.ADMIN_EMAIL) {
    return false;
  }

  const token = await getSessionToken(request);

  if (!token) return false;

  const tokenHash = await hashToken(token);
  const email = await env.AUTH_CODES.get(`session:${tokenHash}`);

  return email === env.ADMIN_EMAIL.trim().toLowerCase();
}

// 检查当前登录状态
export async function onRequestGet({ request, env }) {
  try {
    const loggedIn = await isLoggedIn(request, env);

    return json({
      success: loggedIn,
      loggedIn
    });

  } catch {
    return json({
      success: false,
      loggedIn: false
    }, 500);
  }
}

// 退出登录
export async function onRequestDelete({ request, env }) {
  try {
    // 1. 检查请求来源
    if (!validOrigin(request)) {
      return json(
        { success: false, message: "请求来源不正确" },
        403
      );
    }

    // 2. 删除服务端会话
    const token = await getSessionToken(request);

    if (token && env.AUTH_CODES) {
      const tokenHash = await hashToken(token);

      await env.AUTH_CODES.delete(`session:${tokenHash}`);
    }

    // 3. 清除浏览器 Cookie
    return new Response(
      JSON.stringify({
        success: true,
        message: "已退出登录"
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Set-Cookie": "muyi_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"
        }
      }
    );

  } catch {
    return json(
      { success: false, message: "退出登录失败" },
      500
    );
  }
}
