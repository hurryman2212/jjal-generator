import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const OVERLAY_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.resolve(process.argv[2] || '');
const OUTPUT_ROOT = path.resolve(process.argv[3] || '');
const REQUIRED_SOURCE_FILES = [
  'renderer/index.html',
  'renderer/style.css',
  'renderer/app.js',
  'build/icon.png',
  'LICENSE',
];
const OVERLAY_FILES = [
  'db.js',
  'web-api.js',
  'register-sw.js',
  'manifest.webmanifest',
];

function validateArguments() {
  if (!process.argv[2] || !process.argv[3]) {
    throw new Error('사용법: node web/build.mjs <upstream 경로> <출력 경로>');
  }

  const filesystemRoot = path.parse(OUTPUT_ROOT).root;
  const workingDirectory = path.resolve(process.cwd());
  if (
    OUTPUT_ROOT === filesystemRoot
    || OUTPUT_ROOT === workingDirectory
    || OUTPUT_ROOT === SOURCE_ROOT
    || SOURCE_ROOT.startsWith(`${OUTPUT_ROOT}${path.sep}`)
  ) {
    throw new Error(`안전하지 않은 출력 경로입니다: ${OUTPUT_ROOT}`);
  }
}

async function requireFiles(root, files) {
  for (const relativePath of files) {
    const filePath = path.join(root, relativePath);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      throw new Error(`필수 파일이 없습니다: ${filePath}`);
    }
  }
}

function upstreamCommit() {
  const commit = execFileSync(
    'git',
    ['-C', SOURCE_ROOT, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' }
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`upstream 커밋 SHA가 올바르지 않습니다: ${commit}`);
  }
  return commit;
}

function removeMeta(html, attribute, value) {
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `\\s*<meta\\b(?=[^>]*${attribute}\\s*=\\s*["']${escapedValue}["'])[^>]*\\/?>`,
    'gi'
  );
  return html.replace(pattern, '');
}

function removeLink(html, relation) {
  const escapedRelation = relation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `\\s*<link\\b(?=[^>]*rel\\s*=\\s*["']${escapedRelation}["'])[^>]*\\/?>`,
    'gi'
  );
  return html.replace(pattern, '');
}

function browserHead() {
  return `
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#5b6cf0" />
  <meta name="application-name" content="자짤 생성툴" />
  <meta
    http-equiv="Content-Security-Policy"
    content="
      default-src 'self';
      script-src 'self';
      style-src 'self' 'unsafe-inline';
      img-src 'self' data: blob:;
      font-src 'self' data:;
      media-src 'self' data: blob:;
      connect-src 'none';
      worker-src 'self';
      manifest-src 'self';
      object-src 'none';
      base-uri 'none';
      form-action 'none';
    "
  />
  <link rel="icon" href="./icon.png" type="image/png" />
  <link rel="manifest" href="./manifest.webmanifest" />
`;
}

function patchIndex(sourceHtml) {
  let html = sourceHtml;
  html = removeMeta(html, 'http-equiv', 'Content-Security-Policy');
  html = removeMeta(html, 'name', 'viewport');
  html = removeMeta(html, 'name', 'theme-color');
  html = removeMeta(html, 'name', 'application-name');
  html = removeLink(html, 'icon');
  html = removeLink(html, 'manifest');

  if (!/<\/head>/i.test(html)) {
    throw new Error('upstream index.html에서 </head>를 찾지 못했습니다.');
  }
  html = html.replace(/<\/head>/i, `${browserHead()}</head>`);

  const appScriptPattern = /<script\b[^>]*\bsrc\s*=\s*["'](?:\.\/)?app\.js["'][^>]*>\s*<\/script>/i;
  if (!appScriptPattern.test(html)) {
    throw new Error('upstream index.html에서 app.js 스크립트를 찾지 못했습니다.');
  }
  html = html.replace(
    appScriptPattern,
    [
      '  <script src="./db.js"></script>',
      '  <script src="./web-api.js"></script>',
      '  <script src="./app.js"></script>',
      '  <script src="./register-sw.js"></script>',
    ].join('\n')
  );
  return html;
}

async function listFiles(root, current = '') {
  const directory = path.join(root, current);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

async function contentHash(root, files) {
  const hash = createHash('sha256');
  for (const relativePath of files) {
    hash.update(relativePath.replaceAll(path.sep, '/'));
    hash.update('\0');
    hash.update(await readFile(path.join(root, relativePath)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function replaceOnce(source, placeholder, value) {
  const first = source.indexOf(placeholder);
  if (first < 0 || source.indexOf(placeholder, first + placeholder.length) >= 0) {
    throw new Error(`서비스 워커 템플릿의 ${placeholder} 자리가 올바르지 않습니다.`);
  }
  return source.replace(placeholder, value);
}

async function writeServiceWorker() {
  const outputFiles = (await listFiles(OUTPUT_ROOT))
    .filter((file) => file !== '.nojekyll' && file !== 'service-worker.js');
  const hash = await contentHash(OUTPUT_ROOT, outputFiles);
  const cacheName = `jjal-generator-static-${hash.slice(0, 16)}`;
  const appFiles = [
    './',
    ...outputFiles.map((file) => `./${file.replaceAll(path.sep, '/')}`),
  ];

  let template = await readFile(
    path.join(OVERLAY_ROOT, 'service-worker.template.js'),
    'utf8'
  );
  template = replaceOnce(template, '__CACHE_NAME__', JSON.stringify(cacheName));
  template = replaceOnce(template, '__APP_FILES__', JSON.stringify(appFiles, null, 2));
  await writeFile(path.join(OUTPUT_ROOT, 'service-worker.js'), template, 'utf8');
  return cacheName;
}

async function main() {
  validateArguments();
  await requireFiles(SOURCE_ROOT, REQUIRED_SOURCE_FILES);
  await requireFiles(OVERLAY_ROOT, [
    ...OVERLAY_FILES,
    'service-worker.template.js',
  ]);

  const commit = upstreamCommit();
  await rm(OUTPUT_ROOT, { recursive: true, force: true });
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await cp(path.join(SOURCE_ROOT, 'renderer'), OUTPUT_ROOT, { recursive: true });
  await cp(
    path.join(SOURCE_ROOT, 'build', 'icon.png'),
    path.join(OUTPUT_ROOT, 'icon.png')
  );
  await cp(
    path.join(SOURCE_ROOT, 'LICENSE'),
    path.join(OUTPUT_ROOT, 'LICENSE')
  );

  for (const file of OVERLAY_FILES) {
    await cp(path.join(OVERLAY_ROOT, file), path.join(OUTPUT_ROOT, file));
  }

  const upstreamHtml = await readFile(
    path.join(SOURCE_ROOT, 'renderer', 'index.html'),
    'utf8'
  );
  await writeFile(
    path.join(OUTPUT_ROOT, 'index.html'),
    patchIndex(upstreamHtml),
    'utf8'
  );
  await writeFile(path.join(OUTPUT_ROOT, '.nojekyll'), '', 'utf8');
  await writeFile(
    path.join(OUTPUT_ROOT, 'upstream-version.txt'),
    `${commit}\n`,
    'utf8'
  );

  const cacheName = await writeServiceWorker();
  console.log(`upstream: ${commit}`);
  console.log(`output: ${OUTPUT_ROOT}`);
  console.log(`cache: ${cacheName}`);
}

await main();
