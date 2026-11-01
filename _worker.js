// ============================================================
// 流量杀手 · Cloudflare Pages 静态资源 Worker
//
// 只做静态资源透传（index.html / main.js / res / images）。
// 原先的 /proxy 同源 CORS 代理已删除：它只为“兼容模式探测文件大小”
// 而存在，兼容模式移除后已无任何调用方；且默认不校验 token，
// 等于把站点变成开放代理。
//
// 部署：把仓库连到 Cloudflare Pages（输出目录为仓库根目录），
// 或执行 `npx wrangler pages deploy .`。
// 不需要这一层时，直接删掉本文件即可，Pages 会按纯静态站点托管。
// ============================================================

export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
