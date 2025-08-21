import type { RequestHandler } from "express";
import type { IncomingMessage } from "node:http";
import { URLSearchParams } from "node:url";

const MAX_BODY_SIZE = 100 * 1024; // 100 KB

function getRawBody(req: IncomingMessage, { limit, encoding }: { limit: number, encoding: BufferEncoding }) {
  return new Promise<string>((resolve, reject) => {
    let received = 0;

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > limit)
        return reject(new Error(`Message size exceeds limit of ${limit} bytes`));
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(Buffer.concat(chunks).toString(encoding));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', (error) => {
      reject(error);
    });
  });
}

export const urlEncoded: RequestHandler = async (req, res, next) => {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return next();
  }

  try {
    const body = await getRawBody(req, { limit: MAX_BODY_SIZE, encoding: 'utf-8' });
    req.body = Object.fromEntries(new URLSearchParams(body).entries());
    return next();
  } catch {
    res.status(500).end('Invalid request body');
  }
};

export const json: RequestHandler = async (req, res, next) => {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    return next();
  }

  try {
    const body = await getRawBody(req, { limit: MAX_BODY_SIZE, encoding: 'utf-8' });
    req.body = JSON.parse(body);
    return next();
  } catch {
    res.status(500).end('Invalid request body');
  }
};