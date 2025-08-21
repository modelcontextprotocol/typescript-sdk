import { RequestHandler } from "express";
import { OAuthMetadata, OAuthProtectedResourceMetadata } from "../../../shared/auth.js";
import cors from 'cors';
import { allowedMethods } from "../middleware/allowedMethods.js";

export function metadataHandler(metadata: OAuthMetadata | OAuthProtectedResourceMetadata): RequestHandler {
  return (req, res) => {
    cors()(req, res, () => {
      allowedMethods(['GET'])(req, res, () => {
        res.status(200).json(metadata);
      })
    })
  }
}
