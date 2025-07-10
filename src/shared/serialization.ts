/**
 * JSON serialization optimization module for MCP protocol
 * 
 * This module provides caching and optimization for JSON serialization/deserialization
 * to improve performance in high-frequency request scenarios.
 */

import { JSONRPCMessage, JSONRPCRequest, JSONRPCResponse, JSONRPCError } from "../types.js";

/**
 * Cache entry for serialized JSON strings
 */
interface SerializationCacheEntry {
  value: string;
  createdAt: number;
  accessCount: number;
  lastAccessed: number;
}

/**
 * Template function for fast JSON construction
 */
type JSONTemplate<T = Record<string, unknown>> = (data: T) => string;

/**
 * Configuration for serialization cache
 */
interface SerializationCacheConfig {
  maxEntries: number;
  maxAge: number; // milliseconds
  cleanupInterval: number; // milliseconds
}

/**
 * Default cache configuration
 */
const DEFAULT_CACHE_CONFIG: SerializationCacheConfig = {
  maxEntries: 1000,
  maxAge: 5 * 60 * 1000, // 5 minutes
  cleanupInterval: 60 * 1000, // 1 minute
};

/**
 * High-performance JSON serialization cache
 * 
 * Provides caching for frequently serialized JSON structures to reduce
 * CPU overhead and improve response times.
 */
export class JSONSerializationCache {
  private static instance: JSONSerializationCache;
  private cache = new Map<string, SerializationCacheEntry>();
  private templateCache = new Map<string, JSONTemplate>();
  private cleanupTimer?: NodeJS.Timeout;
  private config: SerializationCacheConfig;

  private constructor(config: Partial<SerializationCacheConfig> = {}) {
    this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
    this.startCleanupTimer();
  }

  /**
   * Get singleton instance
   */
  static getInstance(config?: Partial<SerializationCacheConfig>): JSONSerializationCache {
    if (!JSONSerializationCache.instance) {
      JSONSerializationCache.instance = new JSONSerializationCache(config);
    }
    return JSONSerializationCache.instance;
  }

  /**
   * Generate cache key for JSON-RPC request
   */
  private generateRequestKey(method: string, hasParams: boolean, hasProgressToken: boolean): string {
    return `req:${method}:${hasParams}:${hasProgressToken}`;
  }

  /**
   * Generate cache key for JSON-RPC response
   */
  private generateResponseKey(hasResult: boolean, hasError: boolean): string {
    return `res:${hasResult}:${hasError}`;
  }

  /**
   * Create optimized JSON-RPC request string
   */
  serializeRequest(request: JSONRPCRequest): string {
    const hasParams = request.params !== undefined && request.params !== null;
    const hasProgressToken = hasParams && request.params?._meta?.progressToken !== undefined;
    const cacheKey = this.generateRequestKey(request.method, hasParams, hasProgressToken);

    // Try to get template from cache
    let template = this.templateCache.get(cacheKey);
    
    if (!template) {
      // Create new template
      template = this.createRequestTemplate(hasParams, hasProgressToken);
      this.templateCache.set(cacheKey, template);
    }

    // Use template to generate JSON
    return template(request);
  }

  /**
   * Create optimized JSON-RPC response string
   */
  serializeResponse(response: JSONRPCResponse | JSONRPCError): string {
    const isError = 'error' in response;

    if (isError) {
      // Handle error response
      const cacheKey = this.generateResponseKey(false, true);
      let template = this.templateCache.get(cacheKey) as JSONTemplate<JSONRPCError>;

      if (!template) {
        template = this.createErrorTemplate();
        this.templateCache.set(cacheKey, template);
      }

      return template(response as JSONRPCError);
    } else {
      // Handle success response
      const hasResult = response.result !== undefined;
      const cacheKey = this.generateResponseKey(hasResult, false);
      let template = this.templateCache.get(cacheKey) as JSONTemplate<JSONRPCResponse>;

      if (!template) {
        template = this.createResponseTemplate(hasResult);
        this.templateCache.set(cacheKey, template);
      }

      return template(response as JSONRPCResponse);
    }
  }

  /**
   * Create request template function
   */
  private createRequestTemplate(hasParams: boolean, hasProgressToken: boolean): JSONTemplate<JSONRPCRequest> {
    if (!hasParams) {
      // Simple request without parameters
      return (req: JSONRPCRequest) => 
        `{"jsonrpc":"2.0","id":${req.id},"method":"${req.method}"}`;
    }

    if (hasProgressToken) {
      // Request with progress token
      return (req: JSONRPCRequest) => {
        const paramsStr = JSON.stringify(req.params);
        return `{"jsonrpc":"2.0","id":${req.id},"method":"${req.method}","params":${paramsStr}}`;
      };
    }

    // Request with parameters but no progress token
    return (req: JSONRPCRequest) => {
      const paramsStr = JSON.stringify(req.params);
      return `{"jsonrpc":"2.0","id":${req.id},"method":"${req.method}","params":${paramsStr}}`;
    };
  }

  /**
   * Create error response template function
   */
  private createErrorTemplate(): JSONTemplate<JSONRPCError> {
    return (res: JSONRPCError) => {
      const errorStr = JSON.stringify(res.error);
      return `{"jsonrpc":"2.0","id":${res.id},"error":${errorStr}}`;
    };
  }

  /**
   * Create success response template function
   */
  private createResponseTemplate(hasResult: boolean): JSONTemplate<JSONRPCResponse> {
    if (hasResult) {
      // Success response with result
      return (res: JSONRPCResponse) => {
        const resultStr = JSON.stringify(res.result);
        return `{"jsonrpc":"2.0","id":${res.id},"result":${resultStr}}`;
      };
    }

    // Success response without result
    return (res: JSONRPCResponse) =>
      `{"jsonrpc":"2.0","id":${res.id},"result":null}`;
  }

  /**
   * Cache a serialized value
   */
  private setCacheEntry(key: string, value: string): void {
    // Check cache size limit
    if (this.cache.size >= this.config.maxEntries) {
      this.evictOldestEntries();
    }

    this.cache.set(key, {
      value,
      createdAt: Date.now(),
      accessCount: 1,
      lastAccessed: Date.now(),
    });
  }

  /**
   * Get cached value and update access statistics
   */
  private getCacheEntry(key: string): string | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    // Check if entry is expired
    if (Date.now() - entry.createdAt > this.config.maxAge) {
      this.cache.delete(key);
      return undefined;
    }

    // Update access statistics
    entry.accessCount++;
    entry.lastAccessed = Date.now();
    
    return entry.value;
  }

  /**
   * Evict oldest cache entries when limit is reached
   */
  private evictOldestEntries(): void {
    const entries = Array.from(this.cache.entries());
    
    // Sort by last accessed time (oldest first)
    entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
    
    // Remove oldest 25% of entries
    const toRemove = Math.floor(entries.length * 0.25);
    for (let i = 0; i < toRemove; i++) {
      this.cache.delete(entries[i][0]);
    }
  }

  /**
   * Start periodic cleanup timer
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval);
  }

  /**
   * Clean up expired cache entries
   */
  private cleanup(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.createdAt > this.config.maxAge) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      this.cache.delete(key);
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    cacheSize: number;
    templateCacheSize: number;
    maxEntries: number;
    hitRate: number;
  } {
    const totalAccess = Array.from(this.cache.values())
      .reduce((sum, entry) => sum + entry.accessCount, 0);
    
    return {
      cacheSize: this.cache.size,
      templateCacheSize: this.templateCache.size,
      maxEntries: this.config.maxEntries,
      hitRate: totalAccess > 0 ? this.cache.size / totalAccess : 0,
    };
  }

  /**
   * Clear all caches
   */
  clear(): void {
    this.cache.clear();
    this.templateCache.clear();
  }

  /**
   * Destroy cache and cleanup resources
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.clear();
  }
}

/**
 * Optimized JSON serialization functions
 */
export const OptimizedJSON = {
  /**
   * Serialize JSON-RPC message with caching
   */
  stringify(message: JSONRPCMessage): string {
    const cache = JSONSerializationCache.getInstance();
    
    if ('method' in message) {
      // Request or notification
      return cache.serializeRequest(message as JSONRPCRequest);
    } else {
      // Response or error
      return cache.serializeResponse(message as JSONRPCResponse | JSONRPCError);
    }
  },

  /**
   * Parse JSON with error handling
   */
  parse(json: string): JSONRPCMessage {
    try {
      return JSON.parse(json) as JSONRPCMessage;
    } catch (error) {
      throw new Error(`Failed to parse JSON-RPC message: ${error}`);
    }
  },
};
