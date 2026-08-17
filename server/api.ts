import type { Plugin } from "vite";
import { timingSafeEqual } from "node:crypto";
import { scanAll, sessionDetail } from "./scanner";

function sendJson(res: any, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(json);
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
            const expected = process.env.DASHBOARD_BASIC_AUTH;
            if (expected) {
              const header = String(req.headers.authorization ?? "");
              let supplied = "";
              if (header.startsWith("Basic ")) {
                try {
                  supplied = Buffer.from(header.slice(6), "base64").toString("utf8");
                } catch {
                  supplied = "";
                }
              }
              const a = Buffer.from(supplied);
              const b = Buffer.from(expected);
              if (a.length !== b.length || !timingSafeEqual(a, b)) {
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
