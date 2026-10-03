// A minimal stand-in for an IoTaWatt's HTTP API, for tests.
// Response shapes and the Digest check follow the IoTaWatt firmware.

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

const md5 = (s) => createHash("md5").update(s).digest("hex");

const CONFIG = {
  format: 2,
  inputs: [
    { channel: 0, name: "Volts", type: "VT", model: "generic", cal: 10 },
    { channel: 1, name: "Mains", type: "CT", model: "generic", cal: 100 },
    { channel: 2, name: "Heater", type: "CT", model: "generic", cal: 50 },
    null,
  ],
  outputs: [{ name: "Total", units: "Watts", script: "@1+@2" }],
};

const ROWS = 5;
const T0 = 1767225600; // 2026-01-01T00:00:00Z

// One cycle: current lags voltage by 30 degrees and carries a 30% 3rd harmonic.
function waveform(n = 640) {
  const lines = [`samples ${n}`];
  for (let t = 0; t <= n; t++) {
    const a = (2 * Math.PI * t) / n;
    const v = Math.round(1500 * Math.sin(a));
    const i = Math.round(300 * Math.sin(a - Math.PI / 6) + 90 * Math.sin(3 * a));
    lines.push(`${v},${i}`);
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * @param {{ password?: string, realm?: string }} [opts] Set password to require Digest auth.
 * @returns {Promise<{ port: number, hits: string[], close: () => Promise<void> }>}
 */
export function startMock(opts = {}) {
  const realm = opts.realm ?? "IotaWatt";
  const nonces = new Set();
  const hits = [];

  const authorized = (req, adminOnly) => {
    if (!opts.password) return true;
    const h = req.headers.authorization || "";
    if (!h.startsWith("Digest ")) return false;
    const get = (k) => (h.match(new RegExp(`(?:^|[ ,])${k}="?([^",]+)"?`)) || [])[1];
    const user = get("username"), nonce = get("nonce"), nc = get("nc"), cnonce = get("cnonce");
    const uri = (h.match(/uri="([^"]+)"/) || [])[1];
    if (!nonces.has(nonce) || !cnonce || !nc || uri !== req.url) return false;
    if (adminOnly && user !== "admin") return false;
    const ha1 = md5(`${user}:${realm}:${opts.password}`);
    const ha2 = md5(`${req.method}:${uri}`);
    return get("response") === md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://mock");
    hits.push(req.url);
    const send = (code, type, body, headers = {}) => {
      res.writeHead(code, { "Content-Type": type, ...headers });
      res.end(body);
    };

    if (!authorized(req, url.pathname === "/command")) {
      const nonce = randomBytes(16).toString("hex");
      nonces.add(nonce);
      return send(401, "text/html", "IoTaWatt-Login", {
        "WWW-Authenticate": `Digest realm="${realm}",qop="auth",nonce="${nonce}"`,
      });
    }

    if (url.pathname === "/config.txt") {
      return send(200, "text/plain", JSON.stringify(CONFIG, null, "\t"));
    }

    if (url.pathname === "/status") {
      const out = {};
      if (url.searchParams.has("stats")) {
        out.stats = { currenttime: Math.floor(Date.now() / 1000), version: "02_08_03", frequency: 60 };
      }
      if (url.searchParams.has("inputs")) {
        out.inputs = [
          { channel: 0, Vrms: 120.4567, Hz: 60.01, phase: 0.7 },
          { channel: 1, Watts: " 512", Pf: 0.951175, phase: 0.3 },
          { channel: 2, Watts: "1500", Pf: 0.999, phase: 1 },
        ];
      }
      if (url.searchParams.has("outputs")) {
        out.outputs = [{ name: "Total", units: "Watts", value: 2012 }];
      }
      return send(200, "application/json", JSON.stringify(out));
    }

    if (url.pathname === "/query") {
      const names = url.searchParams.get("select").replace(/^\[|\]$/g, "").split(",");
      const limit = Number(url.searchParams.get("limit")) || 1000;
      const count = Math.min(ROWS, limit);
      const cut = count < ROWS ? T0 + count * 10 : null;
      const rows = Array.from({ length: count }, (_, r) =>
        names.map((n, c) => (c === 0 ? new Date((T0 + r * 10) * 1000).toISOString().slice(0, 19) : 100 * c + r)));
      if (url.searchParams.get("format") === "csv") {
        const labels = names.map((n, c) => (c === 0 ? "Time" : n.split(".")[0]));
        let body = [labels, ...rows].map((r) => r.join(", ")).join("\r\n");
        if (cut) body += `\r\nLimit exceeded at ${cut}`;
        return send(200, "text/plain", body);
      }
      const labels = JSON.stringify(names.map((n, c) => (c === 0 ? "Time" : n.split(".")[0])));
      const body = `{"range":[${T0},${T0 + ROWS * 10}],"labels":${labels},\r\n"data":${JSON.stringify(rows)}` +
        (cut ? `,"limit":${cut}}` : "}");
      return send(200, "application/json", body);
    }

    if (url.pathname === "/command" && url.searchParams.has("sample")) {
      return send(200, "text", waveform());
    }

    send(404, "text/plain", "Not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        hits,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
