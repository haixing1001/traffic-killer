// ============================================================
// 流量杀手 · 二合一 Worker（站点 + 自建 CORS 代理）
//
// 一个 Worker 同时托管整个站点并提供 CORS 代理：
//   - 请求带 ?url=<目标链接> → 代理模式：服务端抓取目标文件，
//     补上 CORS 头后透传（兼容模式靠它读到 Content-Length）
//   - 其他请求 → 静态资源（index.html / main.js / res / images）
//
// 部署（任选其一）：
//   A. 命令行：在仓库根目录执行 `npx wrangler deploy`
//   B. 控制台：Workers & Pages → 连接 Git 仓库 → 部署命令填
//      `npx wrangler deploy`（wrangler.toml 已配好）
//
// 部署完成后，在工具页进入兼容模式，点击“兼容模式”标签，
// 填入代理前缀：https://<你的worker域名>/?url=
// 停止后重新开始生效。
//
// 防盗用（可选）：把下方 TOKEN 改成任意字符串后，代理前缀需写成
//   https://<你的worker域名>/?token=你的字符串&url=
// TOKEN 留空表示不校验。
// ============================================================

const TOKEN = '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Content-Range, Accept-Ranges',
};

async function proxy(request, searchParams) {
  const target = searchParams.get('url');
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
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const { searchParams } = new URL(request.url);
    // 带 ?url= 的请求走代理，其余交给静态资源托管
    if (searchParams.has('url')) {
      return proxy(request, searchParams);
    }
    return env.ASSETS.fetch(request);
  },
};
