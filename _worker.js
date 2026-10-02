// ============================================================
// 流量杀手 · 二合一 Worker（站点 + 自建 CORS 代理）
// 文件名必须是 _worker.js：部署在 Cloudflare Pages 时，只有
// 下划线开头的文件才会被当作 Worker 执行（高级模式），
// 普通 worker.js 只会被当成静态文件原样伺服。
//
// 一个 Worker 同时托管整个站点并提供 CORS 代理：
//   - /proxy?url=<目标链接> → 代理模式：服务端抓取目标文件，
//     补上 CORS 头后透传（兼容模式靠它读到 Content-Length）
//   - 其他请求 → 静态资源（index.html / main.js / res / images）
//
// 部署：把仓库连到 Cloudflare Pages（输出目录为仓库根目录）
// 即可，或在根目录执行 `npx wrangler pages deploy .`。
//
// 页面与本 Worker 同源部署时，兼容模式会自动经 /proxy 探测
// 文件大小，无需任何配置（页面端凭 X-TK-Proxy 标记头校验）。
//
// 防盗用（可选）：把下方 TOKEN 改成任意字符串后，代理前缀需写成
//   https://<你的pages域名>/proxy?token=你的字符串&url=
// TOKEN 留空表示不校验。
// ============================================================

const TOKEN = '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Content-Range, Accept-Ranges, X-TK-Proxy',
};

async function proxy(request, searchParams) {
  const target = searchParams.get('url');
  if (!target) {
    return new Response('missing url parameter', { status: 400, headers: CORS_HEADERS });
  }
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (TOKEN && searchParams.get('token') !== TOKEN) {
    return new Response('forbidden', { status: 403, headers: CORS_HEADERS });
  }
  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      redirect: 'follow',
    });
  } catch (e) {
    return new Response('upstream fetch failed: ' + e.message, { status: 502, headers: CORS_HEADERS });
  }
  const headers = new Headers(upstream.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  // 标记头：页面端凭它确认对面确实是本项目的代理，避免把普通
  // 静态托管（如 GitHub Pages）返回的首页大小误判为目标文件大小
  headers.set('X-TK-Proxy', '1');
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // /proxy?url=<目标> 走代理，其余交给静态资源托管
    if (url.pathname === '/proxy') {
      return proxy(request, url.searchParams);
    }
    return env.ASSETS.fetch(request);
  },
};
