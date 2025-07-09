/**
 * Resource management module for MCP protocol
 * 
 * This module provides unified resource management to prevent memory leaks
 * and ensure proper cleanup of request-related resources.
 */


import { ProgressCallback } from "./protocol.js";

/**
 * Resource entry containing all request-related resources
 */
interface ResourceEntry {
  messageId: number;
  responseHandler?: (response: unknown) => void;
  progressHandler?: ProgressCallback;
  timeoutId?: NodeJS.Timeout;
  abortController?: AbortController;
  createdAt: number;
  lastAccessed: number;
  state: ResourceState;
}

/**
 * Resource state enumeration
 */
enum ResourceState {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  TIMEOUT = 'timeout',
  ERROR = 'error',
  CANCELLED = 'cancelled'
}

/**
 * Resource manager configuration
 */
interface ResourceManagerConfig {
  maxResources: number;
  maxAge: number; // milliseconds
  cleanupInterval: number; // milliseconds
  enableMetrics: boolean;
}

/**
 * Resource usage metrics
 */
interface ResourceMetrics {
  totalCreated: number;
  totalCleaned: number;
  currentActive: number;
  memoryLeaks: number;
  averageLifetime: number;
}

/**
 * Default resource manager configuration
 */
const DEFAULT_CONFIG: ResourceManagerConfig = {
  maxResources: 10000,
  maxAge: 10 * 60 * 1000, // 10 minutes
  cleanupInterval: 30 * 1000, // 30 seconds
  enableMetrics: true,
};

/**
 * Unified resource manager for request lifecycle management
 * 
 * Manages all resources associated with JSON-RPC requests to prevent
 * memory leaks and ensure proper cleanup.
 */
export class ResourceManager {
  private resources = new Map<number, ResourceEntry>();
  private locks = new Map<number, boolean>();
  private cleanupTimer?: NodeJS.Timeout;
  private config: ResourceManagerConfig;
  private metrics: ResourceMetrics;

  constructor(config: Partial<ResourceManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.metrics = {
      totalCreated: 0,
      totalCleaned: 0,
      currentActive: 0,
      memoryLeaks: 0,
      averageLifetime: 0,
    };
    
    this.startCleanupTimer();
  }

  /**
   * Register a new resource entry
   */
  register(messageId: number, options: {
    responseHandler?: (response: unknown) => void;
    progressHandler?: ProgressCallback;
    timeoutId?: NodeJS.Timeout;
    abortController?: AbortController;
  }): void {
    // Check resource limit
    if (this.resources.size >= this.config.maxResources) {
      this.forceCleanupOldest();
    }

    const now = Date.now();
    const resource: ResourceEntry = {
      messageId,
      ...options,
      createdAt: now,
      lastAccessed: now,
      state: ResourceState.PENDING,
    };

    this.resources.set(messageId, resource);
    
    if (this.config.enableMetrics) {
      this.metrics.totalCreated++;
      this.metrics.currentActive = this.resources.size;
    }
  }

  /**
   * Update resource state with atomic operation
   */
  async updateState(messageId: number, newState: ResourceState): Promise<boolean> {
    // Use lock to prevent race conditions
    if (this.locks.get(messageId)) {
      return false; // Already locked
    }

    this.locks.set(messageId, true);
    try {
      const resource = this.resources.get(messageId);
      if (!resource) {
        return false;
      }

      // Validate state transition
      if (!this.isValidStateTransition(resource.state, newState)) {
        return false;
      }

      resource.state = newState;
      resource.lastAccessed = Date.now();
      
      // Auto-cleanup completed/error states after a delay
      if (this.isTerminalState(newState)) {
        setTimeout(() => this.cleanup(messageId), 1000);
      }

      return true;
    } finally {
      this.locks.delete(messageId);
    }
  }

  /**
   * Get resource entry
   */
  get(messageId: number): ResourceEntry | undefined {
    const resource = this.resources.get(messageId);
    if (resource) {
      resource.lastAccessed = Date.now();
    }
    return resource;
  }

  /**
   * Clean up specific resource
   */
  cleanup(messageId: number): boolean {
    const resource = this.resources.get(messageId);
    if (!resource) {
      return false;
    }

    // Clear timeout if exists
    if (resource.timeoutId) {
      clearTimeout(resource.timeoutId);
    }

    // Abort controller if exists
    if (resource.abortController && !resource.abortController.signal.aborted) {
      resource.abortController.abort('Resource cleanup');
    }

    // Clear handlers to prevent memory leaks
    resource.responseHandler = undefined;
    resource.progressHandler = undefined;

    // Remove from maps
    this.resources.delete(messageId);
    this.locks.delete(messageId);

    if (this.config.enableMetrics) {
      this.metrics.totalCleaned++;
      this.metrics.currentActive = this.resources.size;
      
      // Update average lifetime
      const lifetime = Date.now() - resource.createdAt;
      this.metrics.averageLifetime = 
        (this.metrics.averageLifetime + lifetime) / 2;
    }

    return true;
  }

  /**
   * Clean up all resources for a specific state
   */
  cleanupByState(state: ResourceState): number {
    const toCleanup: number[] = [];
    
    for (const [messageId, resource] of this.resources.entries()) {
      if (resource.state === state) {
        toCleanup.push(messageId);
      }
    }

    let cleaned = 0;
    for (const messageId of toCleanup) {
      if (this.cleanup(messageId)) {
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Force cleanup of oldest resources when limit is reached
   */
  private forceCleanupOldest(): void {
    const entries = Array.from(this.resources.entries());
    
    // Sort by creation time (oldest first)
    entries.sort((a, b) => a[1].createdAt - b[1].createdAt);
    
    // Remove oldest 10% of resources
    const toRemove = Math.max(1, Math.floor(entries.length * 0.1));
    for (let i = 0; i < toRemove; i++) {
      const messageId = entries[i][0];
      this.cleanup(messageId);
      
      if (this.config.enableMetrics) {
        this.metrics.memoryLeaks++;
      }
    }
  }

  /**
   * Validate state transition
   */
  private isValidStateTransition(currentState: ResourceState, newState: ResourceState): boolean {
    const validTransitions: Record<ResourceState, ResourceState[]> = {
      [ResourceState.PENDING]: [ResourceState.PROCESSING, ResourceState.CANCELLED, ResourceState.TIMEOUT],
      [ResourceState.PROCESSING]: [ResourceState.COMPLETED, ResourceState.ERROR, ResourceState.CANCELLED, ResourceState.TIMEOUT],
      [ResourceState.COMPLETED]: [], // Terminal state
      [ResourceState.ERROR]: [], // Terminal state
      [ResourceState.CANCELLED]: [], // Terminal state
      [ResourceState.TIMEOUT]: [], // Terminal state
    };

    return validTransitions[currentState]?.includes(newState) ?? false;
  }

  /**
   * Check if state is terminal
   */
  private isTerminalState(state: ResourceState): boolean {
    return [
      ResourceState.COMPLETED,
      ResourceState.ERROR,
      ResourceState.CANCELLED,
      ResourceState.TIMEOUT
    ].includes(state);
  }

  /**
   * Start periodic cleanup timer
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.periodicCleanup();
    }, this.config.cleanupInterval);
  }

  /**
   * Periodic cleanup of expired resources
   */
  private periodicCleanup(): void {
    const now = Date.now();
    const expiredIds: number[] = [];

    for (const [messageId, resource] of this.resources.entries()) {
      // Clean up resources older than maxAge
      if (now - resource.createdAt > this.config.maxAge) {
        expiredIds.push(messageId);
      }
    }

    for (const messageId of expiredIds) {
      this.cleanup(messageId);
      
      if (this.config.enableMetrics) {
        this.metrics.memoryLeaks++;
      }
    }
  }

  /**
   * Get current metrics
   */
  getMetrics(): ResourceMetrics {
    return { ...this.metrics };
  }

  /**
   * Get resource statistics
   */
  getStats(): {
    activeResources: number;
    lockedResources: number;
    maxResources: number;
    memoryUsage: string;
  } {
    return {
      activeResources: this.resources.size,
      lockedResources: this.locks.size,
      maxResources: this.config.maxResources,
      memoryUsage: `${Math.round(this.resources.size * 0.5)}KB`, // Rough estimate
    };
  }

  /**
   * Destroy resource manager and cleanup all resources
   */
  destroy(): void {
    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    // Cleanup all resources
    const allIds = Array.from(this.resources.keys());
    for (const messageId of allIds) {
      this.cleanup(messageId);
    }

    // Clear maps
    this.resources.clear();
    this.locks.clear();
  }
}

/**
 * Singleton resource manager instance
 */
let globalResourceManager: ResourceManager | undefined;

/**
 * Get global resource manager instance
 */
export function getResourceManager(config?: Partial<ResourceManagerConfig>): ResourceManager {
  if (!globalResourceManager) {
    globalResourceManager = new ResourceManager(config);
  }
  return globalResourceManager;
}

/**
 * Export resource state enum for external use
 */
export { ResourceState };
