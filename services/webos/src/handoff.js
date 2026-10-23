"use strict";

// Narrow pinned-TLS bridge for the WebView, which cannot accept a private desktop certificate.
var https = require("https");
var tls = require("tls");
var crypto = require("crypto");
var URL = require("url").URL;

function validate(payload) {
  var launch = payload.launch || {};
  var endpoint = new URL(String(launch.endpoint || ""));
  var octets = endpoint.hostname.split(".").map(Number);
  var privateAddress = octets.length === 4 && octets.every(function (part) {
    return Number.isInteger(part) && part >= 0 && part <= 255;
  }) && (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) || (octets[0] === 169 && octets[1] === 254));
  if (!privateAddress || endpoint.protocol !== "https:" || endpoint.pathname !== "/v1/handoff" ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !/^[0-9a-f]{64}$/.test(launch.certificatePin || "") || !/^[0-9a-f]{64}$/.test(launch.token || "")) {
    throw new Error("Invalid local handoff endpoint");
  }
  var body = payload.status == null ? null : JSON.stringify(payload.status);
  if (body && Buffer.byteLength(body) > 16384) throw new Error("Status too large");
  return { endpoint: endpoint, launch: launch, body: body };
}

function exchange(payload) {
  return new Promise(function (resolve, reject) {
    var validated;
    try { validated = validate(payload); } catch (error) { reject(error); return; }
    var endpoint = validated.endpoint;
    var launch = validated.launch;
    var agent = new https.Agent({ keepAlive: false });
    // Return the TLS socket to HTTP only after checking its exact certificate.
    agent.createConnection = function (options, callback) {
      var socket = tls.connect({ host: endpoint.hostname, port: Number(endpoint.port || 443),
        rejectUnauthorized: false });
      var settled = false;
      function finish(error) {
        if (settled) return;
        settled = true;
        if (error) { socket.destroy(); callback(error); } else callback(null, socket);
      }
      socket.setTimeout(5000, function () { finish(new Error("TLS timeout")); });
      socket.once("error", finish);
      socket.once("secureConnect", function () {
        var certificate = socket.getPeerCertificate();
        var pin = certificate.raw && crypto.createHash("sha256").update(certificate.raw).digest("hex");
        finish(pin === launch.certificatePin ? null : new Error("Desktop certificate mismatch"));
      });
    };
    var request = https.request({ hostname: endpoint.hostname, port: Number(endpoint.port || 443),
      path: endpoint.pathname + (validated.body ? "/status" : ""),
      method: validated.body ? "POST" : "GET", agent: agent,
      headers: { Authorization: "Bearer " + launch.token, "Content-Type": "application/json" }
    }, function (response) {
      var chunks = []; var size = 0;
      response.on("data", function (chunk) {
        size += chunk.length;
        if (size > 16384) { request.destroy(new Error("Response too large")); return; }
        chunks.push(chunk);
      });
      response.on("end", function () {
        agent.destroy();
        if (response.statusCode !== 200) { reject(new Error("Transfer cancelled or expired")); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); }
      });
      response.on("error", reject);
    });
    request.setTimeout(6000, function () { request.destroy(new Error("Handoff request timeout")); });
    request.on("error", function (error) { agent.destroy(); reject(error); });
    request.end(validated.body || undefined);
  });
}

exports.validate = validate;
exports.exchange = exchange;
exports.register = function (service) {
  service.register("handoffRequest", function (message) {
    exchange(message.payload || {}).then(function (result) {
      message.respond({ returnValue: true, result: result });
    }, function () {
      // Credentials, launch tokens and URLs must never appear in service errors.
      message.respond({ returnValue: false, errorCode: -1, errorText: "Local handoff connection failed" });
    });
  });
};
