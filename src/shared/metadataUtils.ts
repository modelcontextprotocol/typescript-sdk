import { BaseMetadata } from "../types.js";

/**
 * Utilities for working with BaseMetadata objects.
 */

/**
 * Gets the display name for an object with BaseMetadata.
 * Returns the title if available, otherwise falls back to name.
 * This implements the spec requirement: "if no title is provided, name should be used for display purposes"
 */
export function getDisplayName(metadata: BaseMetadata): string {
  return metadata.title ?? metadata.name;
}

/**
 * Checks if an object has a custom title different from its name.
 */
export function hasCustomTitle(metadata: BaseMetadata): boolean {
  return metadata.title !== undefined && metadata.title !== metadata.name;
}