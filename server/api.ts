import type { Plugin } from "vite";
import { createHmac, timingSafeEqual } from "node:crypto";
import { scanAll, sessionDetail } from "./scanner";

const SESSION_COOKIE = "ai_session_access";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function sendJson(res: any, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(json);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookieValue(req: any, name: string): string | null {
  const header = String(req.headers.cookie ?? "");
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name)
      return part.slice(eq + 1).trim();
  }
  return null;
}

function sessionSignature(expires: string, secret: string): string {
  return createHmac("sha256", secret).update(expires).digest("base64url");
}

function validSession(req: any, secret: string): boolean {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const expires = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expiresMs = Number(expires);
  return (
    Number.isFinite(expiresMs) &&
    expiresMs > Date.now() &&
    safeEqual(signature, sessionSignature(expires, secret))
  );
}

async function readJsonBody(req: any): Promise<any> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 4096) throw new Error("request too large");
  }
  return JSON.parse(body || "{}");
}

function sendUnlockPage(res: any) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'"
  );
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unlock AI Session Analysis</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090b10;color:#edf1f7;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}.card{width:min(92vw,390px);padding:30px;border:1px solid #2a3140;border-radius:16px;background:#11151d;box-shadow:0 24px 70px #0009}h1{margin:0 0 8px;font-size:22px}p{margin:0 0 22px;color:#9ea9b8}label{display:block;margin-bottom:7px;font-weight:650}input,button{width:100%;height:44px;border-radius:9px;font:inherit}input{padding:0 12px;border:1px solid #394458;background:#090c12;color:#fff;outline:none}input:focus{border-color:#70a5ff;box-shadow:0 0 0 3px #70a5ff26}button{margin-top:12px;border:0;background:#4e83e6;color:#fff;font-weight:750;cursor:pointer}button:disabled{opacity:.65;cursor:wait}.error{min-height:22px;margin:10px 0 0;color:#ff8d98;font-size:13px}
</style></head><body><main class="card"><h1>AI Session Analysis</h1><p>Enter the site password to unlock this private dashboard.</p><form id="unlock"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">Unlock dashboard</button><div class="error" id="error" role="alert"></div></form></main><script>
const form=document.getElementById('unlock'),button=form.querySelector('button'),error=document.getElementById('error');form.addEventListener('submit',async(e)=>{e.preventDefault();button.disabled=true;error.textContent='';try{const response=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:form.password.value})});if(!response.ok){error.textContent=response.status===401?'Incorrect password.':'Unable to unlock right now.';form.password.select();return}location.reload()}catch{error.textContent='Unable to reach the server.'}finally{button.disabled=false}});
</script></body></html>`);
}

export function sessionApiPlugin(): Plugin {
  return {
    name: "claude-session-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        (async () => {
          try {
            if (url.pathname === "/healthz") {
              sendJson(res, 200, { status: "ok" });
              return;
            }
            const dashboardPassword = process.env.DASHBOARD_PASSWORD;
            if (dashboardPassword) {
              const sessionSecret = process.env.DASHBOARD_SESSION_SECRET;
              if (!sessionSecret) {
                sendJson(res, 503, { error: "dashboard session auth is not configured" });
                return;
              }
              if (url.pathname === "/auth/login" && req.method === "POST") {
                let supplied = "";
                try {
                  supplied = String((await readJsonBody(req)).password ?? "");
                } catch {
                  sendJson(res, 400, { error: "invalid request" });
                  return;
                }
                if (!safeEqual(supplied, dashboardPassword)) {
                  sendJson(res, 401, { error: "incorrect password" });
                  return;
                }
                const expiresMs = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
                const expires = String(expiresMs);
                const token = `${expires}.${sessionSignature(expires, sessionSecret)}`;
                res.setHeader(
                  "Set-Cookie",
                  `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`
                );
                sendJson(res, 200, { ok: true });
                return;
              }
              if (!validSession(req, sessionSecret)) {
                const acceptsHtml = String(req.headers.accept ?? "").includes("text/html");
                if (req.method === "GET" && acceptsHtml) sendUnlockPage(res);
                else sendJson(res, 401, { error: "authentication required" });
                return;
              }
            }
            const expected = process.env.DASHBOARD_BASIC_AUTH;
            if (!dashboardPassword && expected) {
              const header = String(req.headers.authorization ?? "");
              let supplied = "";
              if (header.startsWith("Basic ")) {
                try {
                  supplied = Buffer.from(header.slice(6), "base64").toString("utf8");
                } catch {
                  supplied = "";
                }
              }
              if (!safeEqual(supplied, expected)) {
                res.statusCode = 401;
                res.setHeader("WWW-Authenticate", 'Basic realm="AI Session Analysis"');
                res.setHeader("Cache-Control", "no-store");
                res.end("Authentication required");
                return;
              }
            }
            if (url.pathname === "/api/stats") {
              sendJson(res, 200, await scanAll());
              return;
            }
            if (url.pathname === "/api/session") {
              const project = url.searchParams.get("project");
              const id = url.searchParams.get("id");
              const source = url.searchParams.get("source") ?? undefined;
              const host = url.searchParams.get("host") ?? undefined;
              if (!project || !id) {
                sendJson(res, 400, { error: "project and id required" });
                return;
              }
              // basic traversal guard — these values name files under the root
              if (
                /[\\/]|\.\./.test(project) ||
                /[\\/]|\.\./.test(id) ||
                (host && /[\\/]|\.\./.test(host))
              ) {
                sendJson(res, 400, { error: "invalid characters" });
                return;
              }
              const detail = sessionDetail(project, id, source, host);
              if (!detail) {
                sendJson(res, 404, { error: "session not found" });
                return;
              }
              sendJson(res, 200, detail);
              return;
            }
            next();
          } catch (e: any) {
            sendJson(res, 500, { error: String(e?.stack ?? e) });
          }
        })();
      });
    },
  };
}
