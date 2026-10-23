import { validateHandoffRequest } from "./tvHandoffProtocol.js";
import { requestWebOsCompanionService } from "../../platform/webos/webosCompanionService.js";
import { AuthManager } from "../auth/authManager.js";
import { ProfileManager } from "../profile/profileManager.js";
import { Router } from "../../ui/navigation/router.js";
import { PlayerController } from "../player/playerController.js";

let active = null;
let handling = false;
let handlingId = null;
let queuedLaunch = null;


async function exchange(launch, status = null) {
  const response = await requestWebOsCompanionService({ method: "handoffRequest",
    parameters: { launch, status }, timeoutMs: 8000, retryOnFailure: false });
  if (!response.payload?.returnValue) throw new Error("Desktop disconnected");
  return response.payload.result;
}

function approval(message, launch = null, expires = Date.now() + 90000) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#000b;display:flex;align-items:center;justify-content:center";
    const card = document.createElement("div");
    card.style.cssText = "background:#202024;color:white;padding:40px;border-radius:18px;max-width:700px;font-size:26px";
    const text = document.createElement("p"); text.textContent = message;
    const accept = document.createElement("button"); accept.textContent = "Continue";
    const cancel = document.createElement("button"); cancel.textContent = "Cancel";
    [accept, cancel].forEach((button) => { button.style.cssText = "font-size:26px;margin:12px;padding:12px 30px"; });
    let finished = false; let timeout; let poll;
    const finish = (value) => { if (finished) return; finished = true; clearTimeout(timeout); clearInterval(poll); document.removeEventListener("keydown", key, true); overlay.remove(); previous?.focus?.(); resolve(value); };
    const key = (event) => {
      event.preventDefault(); event.stopImmediatePropagation();
      if (["ArrowLeft", "ArrowRight", "Tab"].includes(event.key)) (document.activeElement === accept ? cancel : accept).focus();
      if (event.key === "Enter") finish(document.activeElement === accept);
      if (["Escape", "Backspace", "GoBack"].includes(event.key) || event.keyCode === 461) finish(false);
    };
    accept.onclick = () => finish(true); cancel.onclick = () => finish(false);
    card.append(text, accept, cancel); overlay.append(card); document.body.append(overlay);
    document.addEventListener("keydown", key, true); accept.focus();
    timeout = setTimeout(() => finish(false), Math.max(1, Math.min(90000, expires - Date.now())));
    let polling = false;
    if (launch) poll = setInterval(async () => {
      if (polling || finished) return;
      if (queuedLaunch || Date.now() >= expires) { finish(false); return; }
      polling = true;
      try { await exchange(launch); } catch (_) { finish(false); }
      finally { polling = false; }
    }, 1000);
  });
}


async function receive(launch) {
  if (!launch || typeof launch !== "object" || typeof launch.requestId !== "string") return;
  if (handling) {
    if (launch.requestId !== handlingId) {
      queuedLaunch = launch;
      if (active) active.cancelled = true;
    }
    return;
  }
  handling = true; handlingId = launch.requestId;
  let request;
  let phase = "RECEIVED";
  const status = async (next, positionMs = null, failureCode = null) => {
    await exchange(launch, { requestId: request.requestId, targetDeviceId: request.targetDeviceId,
      phase: next, ...(positionMs == null ? {} : { positionMs }), ...(failureCode ? { failureCode } : {}) });
    phase = next;
  };
  try {
    request = await exchange(launch);
    validateHandoffRequest(request, launch);
    await status("RECEIVED");
    await status("AWAITING_USER");
    const readyDeadline = Date.now() + 30000;
    while ((!AuthManager.isAuthenticated || !ProfileManager.getActiveProfileId() ||
        ["profileSelection", "authQrSignIn"].includes(Router.getCurrent())) && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await exchange(launch);
    }
    if (request.accountId !== await AuthManager.getEffectiveUserId()) throw new Error("Use the same Nuvio account on both devices");
    if (Number(request.profileId) !== Number(ProfileManager.getActiveProfileId())) {
      await status("FAILED", null, "PROFILE_REQUIRED");
      await approval("Select the matching profile on TV, then retry Continue on TV from desktop."); return;
    }
    const seen = JSON.parse(localStorage.getItem("handoff-seen-requests") || "{}");
    Object.keys(seen).forEach((id) => { if (Number(seen[id]) <= Date.now()) delete seen[id]; });
    if (Object.prototype.hasOwnProperty.call(seen, request.requestId) || Object.keys(seen).length >= 128) {
      await status("FAILED", null, "DUPLICATE_REQUEST"); return;
    }
    const trusted = localStorage.getItem(`handoff-desktop-${launch.senderDeviceId}`) === launch.certificatePin;
    const message = trusted ? `Continue “${request.title}” on this TV?` :
      `Pair Nuvio Desktop and continue “${request.title}”? Desktop code: ${String(launch.certificatePin).slice(0, 6).toUpperCase()}`;
    if ((!trusted || Router.getCurrent() === "player") && !await approval(message, launch, request.expiresAtEpochMs)) {
      await status("FAILED", null, "USER_DECLINED"); return;
    }
    validateHandoffRequest(await exchange(launch), launch);
    await status("RESOLVING");
    localStorage.setItem(`handoff-desktop-${launch.senderDeviceId}`, launch.certificatePin);
    Object.defineProperty(seen, request.requestId, { value: request.expiresAtEpochMs, enumerable: true, configurable: true, writable: true });
    localStorage.setItem("handoff-seen-requests", JSON.stringify(seen));
    if (active) active.cancelled = true;
    const session = { request, launch, cancelled: false };
    active = session;
    const previousPlaybackToken = Number(PlayerController.playRequestToken || 0);
    let stableSince = 0;
    let stablePosition = 0;
    let lastSeekAt = 0;
    await Router.navigate("stream", { itemId: request.contentId, videoId: request.videoId,
      itemType: request.contentType, itemTitle: request.title, season: request.season, episode: request.episode,
      resumePositionMs: request.positionMs, resumeDurationMs: request.durationMs,
      startFromBeginning: request.positionMs === 0,
      handoffEditionHint: request.editionHint || null, handoffRequestId: request.requestId });
    await status("AWAITING_USER");
    while (!session.cancelled && active === session && Date.now() < request.expiresAtEpochMs) {
      await exchange(launch); // 410 or disconnection cancels pending playback.
      const current = Router.getCurrent();
      const params = Router.currentParams || {};
      const matches = current === "player" && params.handoffRequestId === request.requestId && String(params.itemId) === request.contentId && String(params.videoId) === request.videoId;
      if (matches && phase !== "LOADING") await status("LOADING");
      const screen = matches ? Router.getCurrentScreen() : null;
      if (matches && Number(PlayerController.playRequestToken || 0) > previousPlaybackToken) {
        const position = Math.round(PlayerController.getCurrentTimeSeconds() * 1000);
        const atTarget = Math.abs(position - request.positionMs) <= 2000;
        if (!atTarget && screen && !screen.pendingPlaybackRestore && Date.now() - lastSeekAt >= 1200) {
          lastSeekAt = Date.now();
          if (request.positionMs === 0) screen.seekPlaybackSeconds(0);
          else {
            screen.pendingPlaybackRestore = { timeSeconds: request.positionMs / 1000, paused: false, attempts: 0, lastAttemptAt: 0 };
            screen.attemptPendingPlaybackRestore({ force: true });
          }
        }
        const ready = atTarget && PlayerController.isPlaying && screen?.hasPresentedPlaybackFrame &&
          !screen.pendingPlaybackRestore && !screen.seekLoading && !PlayerController.video?.seeking;
        if (!ready) stableSince = 0;
        else if (!stableSince) { stableSince = Date.now(); stablePosition = position; }
        else if (Date.now() - stableSince >= 750 && position >= stablePosition + 100) {
          await status("PLAYING", position);
          // Subsequent manual source changes use the current TV position.
          for (const route of [params, screen.params, params.streamRouteParams]) {
            if (route) delete route.handoffRequestId;
          }
          active = null; return;
        }
      } else stableSince = 0;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Transfer expired");
  } catch (_) {
    if (request && active?.request?.requestId === request.requestId) {
      const params = Router.currentParams || {};
      if (Router.getCurrent() === "player" && params.handoffRequestId === request.requestId && String(params.itemId) === request.contentId && String(params.videoId) === request.videoId) PlayerController.pause();
      active = null;
    }
    if (request && phase !== "PLAYING") await status("FAILED", null, "RECEIVER_FAILED").catch(() => {});
  } finally {
    handling = false; handlingId = null;
    const next = queuedLaunch; queuedLaunch = null;
    if (next) void receive(next);
  }
}

function launchPayload(event) {
  const raw = event?.detail || globalThis.webOSSystem?.launchParams || globalThis.PalmSystem?.launchParams || {};
  try { return (typeof raw === "string" ? JSON.parse(raw) : raw)?.handoff; } catch (_) { return null; }
}

export function installTvHandoffReceiver() {
  document.addEventListener("webOSRelaunch", (event) => { void receive(launchPayload(event)); });
  document.addEventListener("webOSLaunch", (event) => { void receive(launchPayload(event)); });
  // Auth/profile initialization may still be routing after bootstrap.
  setTimeout(() => { void receive(launchPayload()); }, 1500);
}
