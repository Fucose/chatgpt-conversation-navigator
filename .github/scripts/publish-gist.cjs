'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPOSITORY = 'Fucose/chatgpt-conversation-navigator';
const GIST_ID = 'fc9f1963666d75e7f93a5edceae137c7';
const FILENAME = 'chatgpt-conversation-navigator.user.js';
const API_URL = `https://api.github.com/gists/${GIST_ID}`;
const RAW_PREFIX = `https://gist.githubusercontent.com/Fucose/${GIST_ID}/raw/`;
const RAW_URL = `${RAW_PREFIX}${FILENAME}`;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERIFY_ATTEMPTS = 21;
const RETRY_DELAY_MS = 15000;

function metadataValue(source, key) {
    const header = source.match(/^\/\/ ==UserScript==\r?\n([\s\S]*?)^\/\/ ==\/UserScript==\r?$/m);
    if (!header || header.index !== 0) {
        throw new Error('Userscript metadata header is missing or invalid.');
    }
    const values = [...header[1].matchAll(/^\/\/\s+@(\S+)\s+(\S+)\s*$/gm)]
        .filter((match) => match[1] === key)
        .map((match) => match[2]);
    if (values.length !== 1) {
        throw new Error(`Userscript metadata must contain exactly one @${key}.`);
    }
    return values[0];
}

function versionParts(version) {
    const match = VERSION_PATTERN.exec(version);
    if (!match) throw new Error('Userscript version must have the format X.Y.Z without leading zeroes.');
    return match.slice(1).map((part) => BigInt(part));
}

function compareVersions(first, second) {
    const a = versionParts(first);
    const b = versionParts(second);
    for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
}

function revisionUrl(gist) {
    const file = gist?.files?.[FILENAME];
    const rawUrl = file?.raw_url;
    const revision = typeof rawUrl === 'string' && rawUrl.startsWith(RAW_PREFIX)
        && rawUrl.endsWith(`/${FILENAME}`)
        ? rawUrl.slice(RAW_PREFIX.length, -(`/${FILENAME}`.length))
        : '';
    if (gist?.id !== GIST_ID || !/^[a-f0-9]{40}$/.test(revision)) {
        throw new Error('Gist response is missing the expected file or its revision URL.');
    }
    return rawUrl;
}

async function gistRequest(fetchImpl, token, method, body) {
    let response;
    try {
        response = await fetchImpl(API_URL, {
            method,
            headers: {
                'Accept': 'application/vnd.github+json',
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'chatgpt-conversation-navigator-publisher',
                'X-GitHub-Api-Version': '2022-11-28'
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: 'error',
            signal: AbortSignal.timeout(10000)
        });
    } catch {
        throw new Error(`Gist API ${method} request failed.`);
    }
    if (!response.ok) throw new Error(`Gist API ${method} failed with HTTP ${response.status}.`);
    try {
        return await response.json();
    } catch {
        throw new Error(`Gist API ${method} returned invalid JSON.`);
    }
}

async function rawBytes(fetchImpl, url) {
    const response = await fetchImpl(url, {
        headers: {'Cache-Control': 'no-cache'},
        signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
}

async function verifyRaw(fetchImpl, url, expected, delay, label) {
    let reason = 'request failed';
    for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
        try {
            if ((await rawBytes(fetchImpl, url)).equals(expected)) return;
            reason = 'content differs';
        } catch {
            reason = 'request failed';
        }
        if (attempt < VERIFY_ATTEMPTS) await delay(RETRY_DELAY_MS);
    }
    throw new Error(`${label} verification failed after ${VERIFY_ATTEMPTS} attempts (${reason}).`);
}

async function publishGist({repository, token, tag, content, fetchImpl = fetch, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))}) {
    if (!token || !token.trim()) throw new Error('GIST_TOKEN secret is missing.');
    if (repository !== REPOSITORY) throw new Error(`Publishing is allowed only from ${REPOSITORY}.`);
    if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag || '')) {
        throw new Error('Release tag must have the format vX.Y.Z without leading zeroes.');
    }
    if (!Buffer.isBuffer(content)) throw new Error('Userscript content must be a Buffer.');
    const source = content.toString('utf8');
    if (!Buffer.from(source, 'utf8').equals(content)) throw new Error('Userscript must be valid UTF-8.');
    const localVersion = metadataValue(source, 'version');
    if (localVersion !== tag.slice(1)) throw new Error('Release tag does not match the userscript @version.');
    if (metadataValue(source, 'updateURL') !== RAW_URL || metadataValue(source, 'downloadURL') !== RAW_URL) {
        throw new Error('Userscript @updateURL and @downloadURL must use the existing Gist URL.');
    }

    const current = await gistRequest(fetchImpl, token, 'GET');
    const currentUrl = revisionUrl(current);
    let existing;
    try {
        existing = await rawBytes(fetchImpl, currentUrl);
    } catch {
        throw new Error('Could not read the current Gist file.');
    }
    const remoteVersion = metadataValue(existing.toString('utf8'), 'version');
    const comparison = compareVersions(localVersion, remoteVersion);
    if (comparison < 0) throw new Error('Refusing to publish an older version than the current Gist.');
    if (comparison === 0 && !existing.equals(content)) {
        throw new Error('Refusing to change Gist content without increasing @version.');
    }

    const result = comparison === 0
        ? current
        : await gistRequest(fetchImpl, token, 'PATCH', {files: {[FILENAME]: {content: source}}});
    const publishedUrl = revisionUrl(result);
    await Promise.all([
        verifyRaw(fetchImpl, publishedUrl, content, delay, 'Revision URL'),
        verifyRaw(fetchImpl, RAW_URL, content, delay, 'Update URL')
    ]);
    return comparison === 0 ? 'already current' : 'published';
}

if (require.main === module) {
    Promise.resolve().then(() => publishGist({
        repository: process.env.GITHUB_REPOSITORY,
        token: process.env.GIST_TOKEN,
        tag: process.env.RELEASE_TAG,
        content: fs.readFileSync(path.join(__dirname, '..', '..', FILENAME))
    })).then((result) => {
        console.log(`Gist userscript ${result} and both raw URLs verified.`);
    }).catch((error) => {
        console.error(`Gist publish failed: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {publishGist};
