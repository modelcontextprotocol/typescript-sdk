import type { RequestHandler } from "express";

export const noopMiddleware: RequestHandler = (req, res, next) => next();