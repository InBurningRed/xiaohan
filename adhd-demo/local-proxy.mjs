import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const port = Number.parseInt(process.env.PORT || "5173", 10);
const defaultBaseUrl = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const defaultApiKey = process.env.DEEPSEEK_API_KEY || "";

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "POST" && url.pathname === "/api/llm/chat") {
      const body = await readJson(req);
      const apiKey = String(body.apiKey || defaultApiKey || "").trim();
      const baseUrl = String(body.baseUrl || defaultBaseUrl || "").trim();
      const payload = {
        model: body.model,
        temperature: body.temperature,
        messages: body.messages,
      };

      if (!apiKey) return sendJson(res, 400, { error: { message: "Missing API key" } });
      if (!payload.model || !Array.isArray(payload.messages)) return sendJson(res, 400, { error: { message: "Invalid payload" } });

      const chatUrl = resolveChatCompletionsUrl(baseUrl);
      const upstream = await fetch(chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
      });

      const text = await upstream.text();
      res.statusCode = upstream.status;
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
      res.end(text);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return;
    }

    const filePath = resolveStaticPath(url.pathname);
    if (!filePath) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", guessContentType(filePath));
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Internal Server Error");
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`http://127.0.0.1:${port}/\n`);
});

function resolveStaticPath(p) {
  const pathname = decodeURIComponent(String(p || "/"));
  const clean = pathname.replace(/\0/g, "");
  const rel = clean === "/" ? "/index.html" : clean;
  const full = path.join(__dirname, rel);
  if (!full.startsWith(__dirname)) return null;
  return full;
}

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".mjs") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".webmanifest") return "application/manifest+json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function resolveChatCompletionsUrl(baseUrl) {
  const raw = String(baseUrl ?? "").trim() || "https://api.deepseek.com";
  if (/\/chat\/completions$/i.test(raw)) return raw;
  const u = raw.replace(/\/+$/g, "");
  if (/\/v1$/i.test(u)) return `${u}/chat/completions`;
  return `${u}/v1/chat/completions`;
}

