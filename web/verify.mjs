import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';

const SOURCE_ROOT = path.resolve(process.argv[2] || '');
const OUTPUT_ROOT = path.resolve(process.argv[3] || '');
const REQUIRED_OUTPUT_FILES = [
  '.nojekyll',
  'LICENSE',
  'index.html',
  'style.css',
  'app.js',
  'db.js',
  'web-api.js',
  'register-sw.js',
  'service-worker.js',
  'manifest.webmanifest',
  'icon.png',
  'upstream-version.txt',
];
const PROVIDED_API_METHODS = new Set([
  'readSpecs',
  'pickImage',
  'listDesigns',
  'loadDesign',
  'saveDesign',
  'deleteDesign',
  'exportPng',
  'exportWebp',
  'importPng',
]);

function validateArguments() {
  if (!process.argv[2] || !process.argv[3]) {
    throw new Error('사용법: node web/verify.mjs <upstream 경로> <출력 경로>');
  }
}

async function requireOutputFiles() {
  for (const relativePath of REQUIRED_OUTPUT_FILES) {
    const filePath = path.join(OUTPUT_ROOT, relativePath);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      throw new Error(`배포 파일이 없습니다: ${filePath}`);
    }
  }
}

async function rejectSymlinks(root, current = '') {
  const entries = await readdir(path.join(root, current), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const relativePath = path.join(current, entry.name);
    const fileStat = await lstat(path.join(root, relativePath));
    if (fileStat.isSymbolicLink()) {
      throw new Error(`Pages 아티팩트에 심볼릭 링크가 있습니다: ${relativePath}`);
    }
    if (fileStat.isDirectory()) await rejectSymlinks(root, relativePath);
  }
}

function apiMethods(source) {
  const methods = new Set();
  const patterns = [
    /window\.api\.([A-Za-z_$][\w$]*)/g,
    /window\.api\?\.([A-Za-z_$][\w$]*)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) methods.add(match[1]);
  }
  return methods;
}

function checkScriptOrder(html) {
  const scripts = [
    './db.js',
    './web-api.js',
    './app.js',
    './register-sw.js',
  ];
  let previousIndex = -1;
  for (const script of scripts) {
    const index = html.indexOf(`src="${script}"`);
    if (index < 0 || index <= previousIndex) {
      throw new Error(`index.html의 스크립트 순서가 올바르지 않습니다: ${script}`);
    }
    previousIndex = index;
  }
}

function rejectInlineScripts(html) {
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    if (!/\bsrc\s*=/i.test(match[1]) && match[2].trim()) {
      throw new Error('CSP로 실행할 수 없는 인라인 스크립트가 index.html에 있습니다.');
    }
  }
}

function rejectExternalRuntimeUrls(files) {
  for (const [file, content] of files) {
    const match = content.match(/https?:\/\//i);
    if (match) {
      throw new Error(`외부 런타임 URL이 포함되어 있습니다: ${file}`);
    }
  }
}

function parseScript(file, source) {
  try {
    new vm.Script(source, { filename: file });
  } catch (error) {
    throw new Error(`${file} JavaScript 문법 오류: ${error.message}`);
  }
}

function gitCommit() {
  return execFileSync(
    'git',
    ['-C', SOURCE_ROOT, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' }
  ).trim();
}

async function main() {
  validateArguments();
  await requireOutputFiles();
  await rejectSymlinks(OUTPUT_ROOT);

  const upstreamApp = await readFile(
    path.join(SOURCE_ROOT, 'renderer', 'app.js')
  );
  const outputApp = await readFile(path.join(OUTPUT_ROOT, 'app.js'));
  if (!upstreamApp.equals(outputApp)) {
    throw new Error('배포 app.js가 upstream renderer/app.js와 일치하지 않습니다.');
  }

  const appSource = outputApp.toString('utf8');
  const webApiSource = await readFile(
    path.join(OUTPUT_ROOT, 'web-api.js'),
    'utf8'
  );
  const usedMethods = apiMethods(appSource);
  const unknownMethods = [...usedMethods]
    .filter((method) => !PROVIDED_API_METHODS.has(method))
    .sort();
  if (unknownMethods.length) {
    throw new Error(
      `웹 호환 계층에 없는 window.api 메서드: ${unknownMethods.join(', ')}`
    );
  }
  for (const method of usedMethods) {
    const methodPattern = new RegExp(`(?:async\\s+)?${method}\\s*\\(`);
    if (!methodPattern.test(webApiSource)) {
      throw new Error(`web-api.js가 ${method} 메서드를 제공하지 않습니다.`);
    }
  }

  const indexSource = await readFile(
    path.join(OUTPUT_ROOT, 'index.html'),
    'utf8'
  );
  checkScriptOrder(indexSource);
  rejectInlineScripts(indexSource);
  if (!/connect-src\s+'none'/i.test(indexSource)) {
    throw new Error("index.html CSP에 connect-src 'none'이 없습니다.");
  }

  const styleSource = await readFile(
    path.join(OUTPUT_ROOT, 'style.css'),
    'utf8'
  );
  const dbSource = await readFile(path.join(OUTPUT_ROOT, 'db.js'), 'utf8');
  const registerSource = await readFile(
    path.join(OUTPUT_ROOT, 'register-sw.js'),
    'utf8'
  );
  const workerSource = await readFile(
    path.join(OUTPUT_ROOT, 'service-worker.js'),
    'utf8'
  );
  rejectExternalRuntimeUrls([
    ['index.html', indexSource],
    ['style.css', styleSource],
    ['app.js', appSource],
    ['db.js', dbSource],
    ['web-api.js', webApiSource],
    ['register-sw.js', registerSource],
  ]);

  for (const [file, source] of [
    ['app.js', appSource],
    ['db.js', dbSource],
    ['web-api.js', webApiSource],
    ['register-sw.js', registerSource],
    ['service-worker.js', workerSource],
  ]) {
    parseScript(file, source);
  }
  if (/__[A-Z_]+__/.test(workerSource)) {
    throw new Error('service-worker.js에 치환되지 않은 템플릿 값이 있습니다.');
  }

  const manifest = JSON.parse(
    await readFile(path.join(OUTPUT_ROOT, 'manifest.webmanifest'), 'utf8')
  );
  if (manifest.start_url !== './' || manifest.scope !== './') {
    throw new Error('manifest의 start_url 또는 scope가 상대 경로가 아닙니다.');
  }

  const expectedCommit = gitCommit();
  const version = (
    await readFile(path.join(OUTPUT_ROOT, 'upstream-version.txt'), 'utf8')
  ).trim();
  if (version !== expectedCommit) {
    throw new Error(
      `upstream 버전 불일치: expected ${expectedCommit}, got ${version}`
    );
  }

  console.log(`verified upstream: ${expectedCommit}`);
  console.log(`window.api methods: ${[...usedMethods].sort().join(', ')}`);
  console.log('runtime external URLs: none');
}

await main();
