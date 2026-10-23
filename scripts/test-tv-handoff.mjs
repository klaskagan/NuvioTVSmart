import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import https from "node:https";
import { createHash } from "node:crypto";
import { preferHandoffEdition, validateHandoffRequest } from "../js/core/handoff/tvHandoffProtocol.js";

const require = createRequire(import.meta.url);
const bridge = require("../services/webos/src/handoff.js");
const now = Date.now();
const launch = { requestId: "request", senderDeviceId: "desktop", targetDeviceId: "tv" };
const request = { version: 1, ...launch, contentId: "tt0133093", videoId: "tt0133093", contentType: "movie",
  positionMs: 60000, durationMs: 600000, createdAtEpochMs: now, expiresAtEpochMs: now + 120000 };

test("validates content identity and expiry", () => {
  assert.doesNotThrow(() => validateHandoffRequest(request, launch, now));
  for (const changed of [{ version: 2 }, { positionMs: -1 }, { targetDeviceId: "another" },
    { expiresAtEpochMs: now }, { expiresAtEpochMs: now + 120001 }, { contentType: "series" }]) {
    assert.throws(() => validateHandoffRequest({ ...request, ...changed }, launch, now));
  }
});

test("edition preference allows a higher-quality release", () => {
  const streams = [{ title: "Movie.1080p.WEB-DL" }, { title: "Movie.EXTENDED.2160p.DV.HDR" }];
  assert.deepEqual(preferHandoffEdition(streams, "extended"), [streams[1]]);
  assert.deepEqual(preferHandoffEdition(streams, "theatrical"), streams);
  assert.deepEqual(preferHandoffEdition(streams, null), streams);
});

test("local bridge rejects public endpoints, redirects and missing authentication", () => {
  const allowed = { endpoint: "https://192.168.1.2:1234/v1/handoff", certificatePin: "a".repeat(64), token: "b".repeat(64) };
  assert.doesNotThrow(() => bridge.validate({ launch: allowed }));
  for (const endpoint of ["https://example.com/v1/handoff", "http://192.168.1.2/v1/handoff",
    "https://127.0.0.1/v1/handoff", "https://192.168.1.2/other", "https://192.168.1.2/v1/handoff?token=1"]) {
    assert.throws(() => bridge.validate({ launch: { ...allowed, endpoint } }));
  }
  assert.throws(() => bridge.validate({ launch: { ...allowed, token: "" } }));
});

test("TLS bridge checks certificate before sending credentials", async () => {
  // Real TLS fixture on a private interface, never an external service.
  const { networkInterfaces } = await import("node:os");
  const address = Object.values(networkInterfaces()).flat().find((entry) => entry && !entry.internal &&
    entry.family === "IPv4" && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address))?.address;
  if (!address) return;
  const directory = mkdtempSync(join(tmpdir(), "nuvio-handoff-tls-"));
  let server;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "key"),
      "-out", join(directory, "cert"), "-days", "1", "-subj", "/CN=Nuvio test"], { stdio: "ignore" });
    const cert = readFileSync(join(directory, "cert"));
    const { X509Certificate } = await import("node:crypto");
    const pin = createHash("sha256").update(new X509Certificate(cert).raw).digest("hex");
    let requests = 0;
    server = https.createServer({ key: readFileSync(join(directory, "key")), cert }, (req, res) => {
      requests++;
      assert.equal(req.headers.authorization, `Bearer ${"b".repeat(64)}`);
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => server.listen(0, address, resolve));
    const payload = { launch: { endpoint: `https://${address}:${server.address().port}/v1/handoff`,
      token: "b".repeat(64), certificatePin: pin } };
    assert.deepEqual(await bridge.exchange(payload), { ok: true });
    assert.equal(requests, 1);
    await assert.rejects(() => bridge.exchange({ launch: { ...payload.launch, certificatePin: "0".repeat(64) } }));
    assert.equal(requests, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

async function isolatedHandoffModule(entry, stubs) {
  const { build } = await import("esbuild");
  const result = await build({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true,
    write: false, format: "esm", platform: "node", plugins: [{ name: "handoff-fixtures", setup(api) {
      api.onResolve({ filter: /.*/ }, ({ path }) => {
        const stub = Object.keys(stubs).find((name) => path.endsWith(name));
        return stub ? { path: stub, namespace: "handoff-fixture" } : null;
      });
      api.onLoad({ filter: /.*/, namespace: "handoff-fixture" }, ({ path }) => ({ contents: stubs[path], loader: "js" }));
    }}] });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

test("actual stream navigation preserves handoff time near start, middle and end", async () => {
  const { isWatchProgressInProgress } = await import("../js/domain/model/watchProgress.js");
  let navigation; let lookups = 0;
  globalThis.__handoffStreamFixture = {
    Router: { getCurrent: () => "stream", navigate: (route, params) => { navigation = { route, params }; } },
    streamRepository: { setLocalPluginSearchPaused() {} },
    watchProgressRepository: { async getResumeByContentId() { lookups++; return { positionMs: 999999 }; } },
    isWatchProgressInProgress
  };
  try {
    const { createStreamScreenMethods10 } = await isolatedHandoffModule("../js/ui/screens/stream/streamScreenMethods-10-play-stream.js", {
      "streamScreen.js": `const f=globalThis.__handoffStreamFixture; export const {Router,streamRepository,watchProgressRepository,isWatchProgressInProgress}=f; export const normalizeType=x=>x;`,
      "streamLinkCacheStore.js": "export const activeStreamLinkProfile=()=>1;"
    });
    const stream = { id: "tv-4k", url: "https://example.invalid/movie" };
    for (const position of [0, 15000, 900000, 7100000]) {
      const screen = { ...createStreamScreenMethods10(), loadToken: 1,
        params: { itemId: "movie", videoId: "movie", itemType: "movie", itemTitle: "Movie",
          handoffRequestId: "transfer", resumePositionMs: position, resumeDurationMs: 7200000 },
        cancelAutoPlayCountdown() {}, cancelAutoPlaySelectionWait() {}, getFilteredStreams: () => [stream], getBackdropUrl: () => null };
      await screen.playStream(stream.id);
      assert.equal(navigation.route, "player");
      assert.equal(navigation.params.resumePositionMs, position);
      assert.equal(navigation.params.handoffRequestId, "transfer");
      assert.equal(navigation.params.startFromBeginning, position === 0);
    }
    assert.equal(lookups, 0, "cloud progress must not replace an explicit handoff time");
  } finally { delete globalThis.__handoffStreamFixture; }
});

test("receiver ignores an old player and confirms only after the new session seeks and advances", async () => {
  const now = Date.now();
  const req = { ...request, createdAtEpochMs: now, expiresAtEpochMs: now + 120000,
    accountId: "account", profileId: 1, positionMs: 900000, durationMs: 7200000 };
  const launchParams = { ...launch, certificatePin: "a".repeat(64) };
  const listeners = new Map(); const storage = new Map();
  storage.set("handoff-desktop-desktop", launchParams.certificatePin);
  const previousDocument = globalThis.document; const previousStorage = globalThis.localStorage;
  let resolvePlaying; let rejectPlaying; let seekAt = 0; let seekCount = 0; let confirmed = false;
  const done = new Promise((resolve, reject) => { resolvePlaying = resolve; rejectPlaying = reject; });
  const controller = { playRequestToken: 1, isPlaying: true, video: { seeking: false },
    getCurrentTimeSeconds: () => controller.playRequestToken === 1 ? 900 : seekAt ? 900 + (Date.now() - seekAt) / 1000 : 0,
    pause() {} };
  const screen = { hasPresentedPlaybackFrame: true, seekLoading: false, pendingPlaybackRestore: null,
    attemptPendingPlaybackRestore() { seekCount++; seekAt = Date.now(); this.pendingPlaybackRestore = null; } };
  const router = { currentParams: {}, route: "home", getCurrent() { return this.route; },
    getCurrentScreen: () => screen,
    async navigate(_, params) { this.route = "player"; this.currentParams = screen.params = params; } };
  globalThis.document = { addEventListener: (name, callback) => listeners.set(name, callback) };
  globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  globalThis.__handoffReceiverFixture = { controller, router, async bridge({ parameters }) {
    const update = parameters.status;
    if (update?.phase === "FAILED") rejectPlaying(new Error(update.failureCode));
    if (update?.phase === "PLAYING") { confirmed = true; resolvePlaying(update); }
    return { payload: { returnValue: true, result: update ? {} : req } };
  } };
  let timer;
  try {
    const { installTvHandoffReceiver } = await isolatedHandoffModule("../js/core/handoff/tvHandoffReceiver.js", {
      "webosCompanionService.js": "export const requestWebOsCompanionService=x=>globalThis.__handoffReceiverFixture.bridge(x);",
      "authManager.js": "export const AuthManager={isAuthenticated:true,getEffectiveUserId:async()=> 'account'};",
      "profileManager.js": "export const ProfileManager={getActiveProfileId:()=>1};",
      "router.js": "export const Router=globalThis.__handoffReceiverFixture.router;",
      "playerController.js": "export const PlayerController=globalThis.__handoffReceiverFixture.controller;"
    });
    installTvHandoffReceiver();
    listeners.get("webOSRelaunch")({ detail: { handoff: launchParams } });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(confirmed, false, "matching time from the previous player is not proof of a transfer");
    controller.playRequestToken = 2;
    const update = await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("handoff did not complete")), 5000); })]);
    assert.ok(seekCount > 0);
    assert.ok(Date.now() - seekAt >= 750);
    assert.ok(update.positionMs >= req.positionMs && update.positionMs <= req.positionMs + 2000);
  } finally {
    clearTimeout(timer); globalThis.document = previousDocument; globalThis.localStorage = previousStorage;
    delete globalThis.__handoffReceiverFixture;
  }
});
