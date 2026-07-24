#!/usr/bin/env node

import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  createReadStream,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const usage = () => {
  console.error(
    "Usage: serve-preview.mjs --dir <preview-directory> [--host <host>] " +
      "[--port <port>] [--token-file </private/tmp/path>]",
  );
};

const fail = (message) => {
  console.error(`Android preview server: ${message}`);
  process.exit(1);
};

const parseArgs = (args) => {
  const options = {
    dir: "",
    host: "0.0.0.0",
    port: 41739,
    tokenFile: "",
  };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (!["--dir", "--host", "--port", "--token-file"].includes(name) || !value) {
      usage();
      process.exit(2);
    }
    index += 1;
    if (name === "--dir") options.dir = value;
    if (name === "--host") options.host = value;
    if (name === "--port") options.port = Number(value);
    if (name === "--token-file") options.tokenFile = value;
  }
  if (!options.dir) {
    usage();
    process.exit(2);
  }
  if (
    !Number.isSafeInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535
  ) {
    fail("port must be an integer between 0 and 65535");
  }
  return options;
};

const regularFile = (file) => {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    fail(`required file is missing: ${path.basename(file)}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`required path must be a regular file: ${path.basename(file)}`);
  }
  return stat;
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const loadCandidate = (directory) => {
  const root = path.resolve(directory);
  const manifestPath = path.join(root, "latest.json");
  const apkPath = path.join(root, "moa-assistant.apk");
  const manifestStat = regularFile(manifestPath);
  const apkStat = regularFile(apkPath);
  let manifest;
  let manifestBytes;
  try {
    manifestBytes = readFileSync(manifestPath);
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    fail("latest.json must contain valid JSON");
  }
  const apkBytes = readFileSync(apkPath);
  const digest = sha256(apkBytes);
  if (
    manifest?.app_id !== "ai.moa.assistant" ||
    manifest?.apk !== "moa-assistant.apk" ||
    !Number.isSafeInteger(manifest?.version_code) ||
    manifest.version_code <= 0 ||
    manifest?.size_bytes !== apkStat.size ||
    manifest?.sha256 !== digest
  ) {
    fail("latest.json does not match the preview APK");
  }
  return {
    apkPath,
    apkSize: apkStat.size,
    digest,
    manifestBytes,
    manifestSize: manifestStat.size,
  };
};

const createTokenFile = (requestedPath) => {
  const privateTmp = path.resolve("/private/tmp");
  let tokenFile;
  if (requestedPath) {
    tokenFile = path.resolve(requestedPath);
    if (
      tokenFile === privateTmp ||
      !tokenFile.startsWith(`${privateTmp}${path.sep}`)
    ) {
      fail("token file must be a child of /private/tmp");
    }
  } else {
    const tokenDirectory = mkdtempSync(
      path.join(privateTmp, "moa-android-preview-"),
    );
    tokenFile = path.join(tokenDirectory, "bearer-token");
  }
  const token = randomBytes(32).toString("base64url");
  let descriptor;
  try {
    descriptor = openSync(tokenFile, "wx", 0o600);
    writeFileSync(descriptor, `${token}\n`, { encoding: "utf8" });
  } catch {
    fail("could not create the private token file");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return { token, tokenFile };
};

const tokenMatches = (receivedToken, expectedToken) => {
  if (typeof receivedToken !== "string") return false;
  const received = Buffer.from(receivedToken, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return received.length === expected.length && timingSafeEqual(received, expected);
};

const securityHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const sendText = (response, status, body) => {
  response.writeHead(status, {
    ...securityHeaders,
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(body);
};

const options = parseArgs(process.argv.slice(2));
const candidate = loadCandidate(options.dir);
const { token, tokenFile } = createTokenFile(options.tokenFile);

const server = createServer((request, response) => {
  let requestUrl;
  try {
    requestUrl = new URL(request.url ?? "/", "http://preview.invalid");
  } catch {
    sendText(response, 400, "Bad Request\n");
    return;
  }
  const authorization = request.headers.authorization;
  const bearerToken =
    typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : null;
  const queryTokens = requestUrl.searchParams.getAll("token");
  const queryAuthorized =
    (request.method === "GET" || request.method === "HEAD") &&
    queryTokens.length === 1 &&
    tokenMatches(queryTokens[0], token);
  if (!tokenMatches(bearerToken, token) && !queryAuthorized) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="moa-android-preview"');
    sendText(response, 401, "Unauthorized\n");
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendText(response, 405, "Method Not Allowed\n");
    return;
  }
  const { pathname } = requestUrl;
  if (pathname === "/latest.json") {
    response.writeHead(200, {
      ...securityHeaders,
      "Content-Length": candidate.manifestSize,
      "Content-Type": "application/json; charset=utf-8",
      ETag: `"sha256-${sha256(candidate.manifestBytes)}"`,
    });
    response.end(request.method === "HEAD" ? undefined : candidate.manifestBytes);
    return;
  }
  if (pathname === "/moa-assistant.apk") {
    response.writeHead(200, {
      ...securityHeaders,
      "Content-Disposition": 'attachment; filename="moa-assistant-preview.apk"',
      "Content-Length": candidate.apkSize,
      "Content-Type": "application/vnd.android.package-archive",
      ETag: `"sha256-${candidate.digest}"`,
    });
    if (request.method === "HEAD") {
      response.end();
    } else {
      createReadStream(candidate.apkPath).pipe(response);
    }
    return;
  }
  sendText(response, 404, "Not Found\n");
});

server.on("error", (error) => {
  try {
    unlinkSync(tokenFile);
  } catch {
    // The path is already absent or inaccessible; do not hide the listen error.
  }
  fail(error.message);
});

server.listen(options.port, options.host, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  console.log(`Android preview server listening at http://${options.host}:${port}`);
  console.log(`Bearer token file: ${tokenFile}`);
  console.log("Only /latest.json and /moa-assistant.apk are exposed.");
});

let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  server.close(() => {
    try {
      unlinkSync(tokenFile);
    } catch {
      // Best-effort removal. The token is still mode 0600 and expires with process.
    }
    process.exit(0);
  });
};

process.on("SIGINT", close);
process.on("SIGTERM", close);
