/**
 * 构建产物守卫：client/dist 是提交进仓库的部署产物（1G 小机不做构建，这是既定取舍），
 * 真实风险是「改了 client/src 却忘记 npm run build 就提交」——线上继续发旧包且无任何报错。
 *
 * 本脚本把 vite 构建输出到临时目录，比对 index.html 引用的哈希资源名与已提交产物是否一致。
 * 哈希是内容确定性哈希（同源码同依赖必同名，已实测两次构建结果一致），约 1-2 秒。
 * 用法：npm run check:dist（CI 与本地均可）。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = path.join(repoRoot, 'client');
const distDir = path.join(clientDir, 'dist');
const tmpOut = 'dist-verify-tmp';
const tmpPath = path.join(clientDir, tmpOut);

const assetRe = /assets\/(index-[A-Za-z0-9_-]+\.(?:js|css))/g;
const refs = (html) => [...html.matchAll(assetRe)].map((m) => m[1]).sort();

const committed = refs(fs.readFileSync(path.join(distDir, 'index.html'), 'utf-8'));
if (committed.length === 0) {
  console.error('✗ client/dist/index.html 未引用任何哈希产物（dist 缺失或被清空）');
  process.exit(1);
}

execSync(`npx vite build --outDir ${tmpOut} --emptyOutDir`, { cwd: clientDir, stdio: 'pipe' });
try {
  const fresh = refs(fs.readFileSync(path.join(tmpPath, 'index.html'), 'utf-8'));
  if (fresh.join() !== committed.join()) {
    console.error('✗ client/dist 与当前源码不一致（改了 src 忘记构建就提交？）');
    console.error('  已提交产物:', committed.join(', '));
    console.error('  重新构建后:', fresh.join(', '));
    console.error('  修复：npm run build -w client 后重新提交');
    process.exit(1);
  }
  console.log(`✓ client/dist 与当前源码一致（${committed.join(', ')}）`);
} finally {
  fs.rmSync(tmpPath, { recursive: true, force: true });
}
