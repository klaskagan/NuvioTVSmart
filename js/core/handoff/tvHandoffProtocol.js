export function preferHandoffEdition(streams, hint) {
  if (!hint) return streams;
  const pattern = hint === "director's cut" ? /\bdirector(?:s|'s)?\s+cut\b/ : new RegExp(`\\b${String(hint).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const matches = streams.filter((stream) => pattern.test(
    [stream.name, stream.title, stream.description, stream.behaviorHints?.filename].filter(Boolean).join(" ").toLowerCase().replace(/[._-]+/g, " ")
  ));
  return matches.length ? matches : streams;
}


export function validateHandoffRequest(request, launch, now = Date.now()) {
  if (request.version !== 1 || request.requestId !== launch.requestId || request.targetDeviceId !== launch.targetDeviceId ||
      request.senderDeviceId !== launch.senderDeviceId || !["movie", "series"].includes(request.contentType) ||
      !Number.isSafeInteger(request.positionMs) || request.positionMs < 0 || request.positionMs >= request.durationMs ||
      !Number.isSafeInteger(request.createdAtEpochMs) || !Number.isSafeInteger(request.expiresAtEpochMs) ||
      request.createdAtEpochMs > now + 5000 || request.expiresAtEpochMs <= now ||
      request.expiresAtEpochMs <= request.createdAtEpochMs || request.expiresAtEpochMs - request.createdAtEpochMs > 120000 ||
      !String(request.contentId || "").trim() || !String(request.videoId || "").trim() ||
      (request.contentType === "series" && (!Number.isInteger(request.season) || request.season < 0 || !Number.isInteger(request.episode) || request.episode < 1))) {
    throw new Error("Invalid or expired handoff");
  }
}


// An explicit handoff timestamp takes precedence over Continue Watching thresholds.
export function handoffResumeParameters(params = {}) {
  const positionMs = Number(params.resumePositionMs);
  const durationMs = Number(params.resumeDurationMs);
  if (!params.handoffRequestId || !Number.isSafeInteger(positionMs) || positionMs < 0 ||
      !Number.isSafeInteger(durationMs) || durationMs <= positionMs) return null;
  return { resumePositionMs: positionMs, resumeDurationMs: durationMs,
    resumeProgressPercent: null, startFromBeginning: positionMs === 0,
    handoffRequestId: params.handoffRequestId };
}
