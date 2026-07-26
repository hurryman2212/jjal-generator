import { appendFile } from 'node:fs/promises';
import process from 'node:process';

const REPOSITORY = process.env.UPSTREAM_REPOSITORY || '4katpapa/jjal-generator';
const REF = process.env.UPSTREAM_REF || 'main';
const VERSION_URL = process.env.UPSTREAM_VERSION_URL
  || 'https://hurryman2212.github.io/jjal-generator/upstream-version.txt';

function requestHeaders() {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'jjal-generator-pages-tracker',
    'x-github-api-version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function latestCommit() {
  const ref = encodeURIComponent(REF);
  const response = await fetch(
    `https://api.github.com/repos/${REPOSITORY}/commits/${ref}`,
    {
      headers: requestHeaders(),
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `upstream 커밋 조회 실패 (${response.status}): ${body.slice(0, 300)}`
    );
  }

  const payload = await response.json();
  if (!payload || !/^[0-9a-f]{40}$/.test(payload.sha || '')) {
    throw new Error('GitHub API가 올바른 upstream 커밋 SHA를 반환하지 않았습니다.');
  }
  return payload.sha;
}

async function deployedCommit() {
  const separator = VERSION_URL.includes('?') ? '&' : '?';
  const cacheBuster = encodeURIComponent(
    process.env.GITHUB_RUN_ID || String(Date.now())
  );
  const response = await fetch(
    `${VERSION_URL}${separator}check=${cacheBuster}`,
    {
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!response.ok) return null;

  const commit = (await response.text()).trim();
  return /^[0-9a-f]{40}$/.test(commit) ? commit : null;
}

async function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, 'utf8');
}

async function main() {
  const latest = await latestCommit();
  let deployed = null;
  let changed = true;

  if (process.env.GITHUB_EVENT_NAME === 'schedule') {
    try {
      deployed = await deployedCommit();
      changed = deployed !== latest;
    } catch (error) {
      console.warn(`현재 배포 버전 확인 실패: ${error.message}`);
    }
  }

  await setOutput('sha', latest);
  await setOutput('changed', String(changed));
  console.log(`upstream latest: ${latest}`);
  console.log(`currently deployed: ${deployed || 'unknown'}`);
  console.log(`deploy required: ${changed}`);
}

await main();
