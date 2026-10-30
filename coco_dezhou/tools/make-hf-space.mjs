/**
 * 打包一个可以直接上传到 Hugging Face Spaces 的 Docker Space 目录。
 *
 *   node tools/make-hf-space.mjs
 *   → dist/hf-space/  （把里面的文件拖进 Space 的 Files 页面即可）
 *
 * Space 的 README.md 必须带 YAML 头（sdk: docker / app_port），
 * 而项目根目录的 README.md 要留给人看，所以这里单独生成一份。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist', 'hf-space');
const APP_PORT = 18080;

const COPY = ['Dockerfile', 'package.json', 'server', 'shared', 'web'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const item of COPY) {
  const src = path.join(ROOT, item);
  const dest = path.join(OUT, item);
  const stat = fs.statSync(src);
  if (stat.isDirectory()) fs.cpSync(src, dest, { recursive: true });
  else fs.copyFileSync(src, dest);
}

const readme = `---
title: 德扑云桌
emoji: "♠"
colorFrom: green
colorTo: gray
sdk: docker
app_port: ${APP_PORT}
pinned: false
license: mit
short_description: 手机多人德州扑克，房间号入场
---

# 德扑云桌 · 手机多人德州扑克

手机浏览器打开本 Space 地址即可开桌：创建房间 → 设人数 / 起始筹码 / 大小盲 → 把 6 位房号发给朋友。

- 部署方式：Docker（\`app_port: ${APP_PORT}\`）
- 首次打开可能需要等 Space 构建完成（Build 日志走完）
- 免费档的 Space 长时间无人访问会休眠，再次打开需要几十秒唤醒

> 本目录由 \`tools/make-hf-space.mjs\` 生成，请勿手工修改。
`;

fs.writeFileSync(path.join(OUT, 'README.md'), readme, 'utf8');

const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full);
    else files.push(path.relative(OUT, full));
  }
})(OUT);

console.log('已生成 Hugging Face Space 目录：' + path.relative(ROOT, OUT));
console.log('文件数：' + files.length);
console.log('');
console.log('下一步：');
console.log('  1. huggingface.co/new-space → SDK 选 Docker → Blank');
console.log('  2. 把 dist/hf-space 里的全部文件拖到 Space 的 Files 页面（含 README.md、Dockerfile）');
console.log('  3. 等 Build 完成，打开 https://<用户名>-<space名>.hf.space');
