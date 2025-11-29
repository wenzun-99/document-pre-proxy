#!/usr/bin/env node
/**
 * upload_proxy.js
 *
 * Express-based upload proxy for Paperless-ngx.
 * - Rewrites JSON file parts by wrapping with HEADER/FOOTER and setting content-type to text/plain
 * - Forwards everything else untouched (preserves form fields)
 *
 * Notes:
 * - This implementation buffers each uploaded file in memory (Buffer). Suitable for typical document sizes.
 * - For very large files use a streaming approach (see notes below).
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const Busboy = require("busboy");

import express from "express";
import FormData from "form-data";
import pino from "pino";
import { fetch } from "undici";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const UPSTREAM = process.env.PAPERLESS_UPSTREAM || "http://localhost:8001";
const HEADER = "---BEGIN JSON-----";
const FOOTER = "---END JSON-----";
const MAX_SNIFF = 4096; // bytes to inspect for JSON detection

const app = express();

const looksLikeJsonBuffer = (buf) => {
  if (!buf || buf.length === 0) return false;
  // skip leading whitespace
  let i = 0;
  while (
    i < buf.length &&
    (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)
  )
    i++;
  if (i >= buf.length) return false;
  const first = buf[i];
  return first === 0x7b /*{*/ || first === 0x5b /*[*/;
};

// Helper to read stream into buffer (returns Promise<Buffer>)
const streamToBuffer = (stream) => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", (err) => reject(err));
  });
};

app.use(async (req, res) => {
  try {
    const upstreamUrl = UPSTREAM + req.originalUrl;
    logger.info(
      { method: req.method, url: req.originalUrl, upstream: upstreamUrl },
      "Incoming request"
    );

    // Copy headers but remove hop-by-hop ones that will be re-added by node-fetch / underlying agent
    const forwardHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const low = k.toLowerCase();
      if (
        [
          "host",
          "content-length",
          "transfer-encoding",
          "content-encoding",
          "connection",
        ].includes(low)
      )
        continue;
      forwardHeaders[k] = v;
    }

    // If it's a multipart POST/PUT/PATCH, parse with Busboy and reconstruct with form-data
    const contentType = req.headers["content-type"] || "";
    if (
      req.method.match(/^(POST|PUT|PATCH)$/i) &&
      contentType.startsWith("multipart/form-data")
    ) {
      // We must parse the multipart body
      const bb = new Busboy({ headers: req.headers });
      const form = new FormData();

      // collect form fields and files
      const filePromises = []; // to await all file buffers

      bb.on("field", (fieldname, val) => {
        form.append(fieldname, val);
      });

      bb.on("file", (fieldname, fileStream, filename, encoding, mimetype) => {
        // push a promise to handle this file
        const p = (async () => {
          try {
            // read a small prefix to sniff for JSON. Because busboy gives us a stream, we need to buffer.
            const buf = await streamToBuffer(fileStream);
            const sniff = buf.slice(0, MAX_SNIFF);
            let rewrite = false;
            if (mimetype && mimetype.toLowerCase() === "application/json") {
              rewrite = true;
            } else if (looksLikeJsonBuffer(sniff)) {
              rewrite = true;
            }

            if (rewrite) {
              logger.info(
                { field: fieldname, filename, mimetype },
                "Rewriting JSON file part -> text/plain"
              );
              // wrap bytes with header and footer. Keep raw bytes exactly as-is between markers.
              const wrapped = Buffer.concat([
                Buffer.from(HEADER + "\n", "utf8"),
                buf,
                Buffer.from("\n" + FOOTER + "\n", "utf8"),
              ]);
              form.append(fieldname, wrapped, {
                filename: filename || "upload",
                contentType: "text/plain",
              });
            } else {
              // append original bytes with original mimetype
              form.append(fieldname, buf, {
                filename: filename || "upload",
                contentType: mimetype || "application/octet-stream",
              });
            }
          } catch (err) {
            logger.error(
              { err, fieldname, filename },
              "Error handling file part"
            );
            throw err;
          }
        })();
        filePromises.push(p);
      });

      bb.on("error", (err) => {
        logger.error({ err }, "Busboy parsing error");
        res.status(500).send("Upload parse error");
      });

      bb.on("finish", async () => {
        try {
          await Promise.all(filePromises);
          // Build fetch options. Note: form.getHeaders() returns correct multipart headers.
          const headers = { ...forwardHeaders, ...form.getHeaders() };

          // Forward cookies if present
          if (req.headers.cookie) headers["cookie"] = req.headers.cookie;

          const upstreamResp = await fetch(upstreamUrl, {
            method: req.method,
            headers,
            body: form,
            redirect: "manual",
            // optionally set timeout / agent
          });

          // Relay status and headers
          upstreamResp.headers.forEach((v, k) => {
            // skip hop-by-hop headers
            if (
              [
                "content-encoding",
                "transfer-encoding",
                "content-length",
                "connection",
              ].includes(k.toLowerCase())
            )
              return;
            res.setHeader(k, v);
          });
          res.status(upstreamResp.status);
          const bodyBuffer = await upstreamResp.buffer();
          res.send(bodyBuffer);
        } catch (err) {
          logger.error({ err }, "Failed to forward multipart request");
          res.status(502).send("Upstream forwarding error");
        }
      });

      // pipe incoming request into busboy
      req.pipe(bb);
      return; // handled
    }

    // Non-multipart: simply proxy the body/passthrough
    // Read raw body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    // Forward request to upstream
    const nonMultiHeaders = { ...forwardHeaders };
    if (req.headers.cookie) nonMultiHeaders["cookie"] = req.headers.cookie;
    const upstreamResp2 = await fetch(upstreamUrl, {
      method: req.method,
      headers: nonMultiHeaders,
      body: body.length ? body : undefined,
      redirect: "manual",
    });

    upstreamResp2.headers.forEach((v, k) => {
      if (
        [
          "content-encoding",
          "transfer-encoding",
          "content-length",
          "connection",
        ].includes(k.toLowerCase())
      )
        return;
      res.setHeader(k, v);
    });
    res.status(upstreamResp2.status);
    const body2 = await upstreamResp2.buffer();
    res.send(body2);
  } catch (err) {
    logger.error({ err }, "Unexpected error in proxy");
    res.status(500).send("Proxy error");
  }
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  logger.info(
    `Upload proxy listening on 0.0.0.0:${PORT}, forwarding to ${UPSTREAM}`
  );
});
