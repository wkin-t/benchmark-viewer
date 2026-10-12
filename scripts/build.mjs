// 把 web/ 打包成 dist/：从 index.html 出发，沿 import 与 url() 引用给 JS、CSS、字体加内容 hash。
// 外层反向代理给静态资源设了 30 天缓存，文件名不变时浏览器会拿旧模块配新模块，导入名对不上整页白屏。
// 带 hash 后每个版本的文件名都不同，只有 index.html（no-cache）决定用哪一套。
// 不依赖第三方包：镜像构建阶段不需要 npm install。
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'web');
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'dist'));

// 页面运行时 fetch 的数据和许可证文本保持原名：数据由 no-cache 的接口路径提供，不需要 hash。
const COPY_AS_IS = ['data', 'fonts/OFL.txt'];

const JS_REF = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\2/g;
const CSS_REF = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const HTML_REF = /\b(src|href)="([^"]+\.(?:js|css))"/g;

const hashed = new Map();

function isRelative(ref) {
  return !/^(?:[a-z]+:|\/\/|\/|#)/i.test(ref);
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

// vendor 里的压缩代码不扫描引用：其中的字符串可能恰好像 import 语句，只按原样加 hash。
function shouldScan(file) {
  const rel = toPosix(path.relative(srcDir, file));
  return !rel.startsWith('vendor/') && /\.(?:js|css)$/.test(file);
}

function rewriteRef(fromFile, ref) {
  const target = path.resolve(path.dirname(fromFile), ref);
  if (!existsSync(target)) {
    throw new Error(`${toPosix(path.relative(srcDir, fromFile))} 引用了不存在的文件 ${ref}`);
  }
  const outRel = emit(target);
  let rel = toPosix(path.relative(path.dirname(path.relative(srcDir, fromFile)), outRel));
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

// 先处理被依赖的文件，自身内容里写的是依赖的新文件名，所以依赖变了 hash 也会跟着变。
function emit(file) {
  if (hashed.has(file)) return hashed.get(file);
  hashed.set(file, null);

  let content = readFileSync(file);
  if (shouldScan(file)) {
    let text = content.toString('utf8');
    if (file.endsWith('.js')) {
      text = text.replace(JS_REF, (_, head, q, ref) => `${head}${q}${rewriteRef(file, ref)}${q}`);
    } else {
      text = text.replace(CSS_REF, (whole, q, ref) =>
        isRelative(ref) ? `url(${q}${rewriteRef(file, ref)}${q})` : whole);
    }
    content = Buffer.from(text, 'utf8');
  }

  const hash = createHash('sha256').update(content).digest('hex').slice(0, 10);
  const rel = path.relative(srcDir, file);
  const ext = path.extname(rel);
  const outRel = toPosix(rel.slice(0, -ext.length) + '.' + hash + ext);

  const dest = path.join(outDir, outRel);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, content);
  hashed.set(file, outRel);
  return outRel;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const indexFile = path.join(srcDir, 'index.html');
const html = readFileSync(indexFile, 'utf8').replace(HTML_REF, (whole, attr, ref) =>
  isRelative(ref) ? `${attr}="${rewriteRef(indexFile, ref).replace(/^\.\//, '')}"` : whole);
writeFileSync(path.join(outDir, 'index.html'), html);

for (const rel of COPY_AS_IS) {
  cpSync(path.join(srcDir, rel), path.join(outDir, rel), { recursive: true });
}

for (const outRel of hashed.values()) console.log(outRel);
console.log(`已输出到 ${toPosix(path.relative(root, outDir)) || outDir}`);
