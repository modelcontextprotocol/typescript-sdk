/**
 * Request state management module for MCP protocol
 * 
 * This module provides atomic state management for JSON-RPC requests
 * to prevent race conditions and ensure consistent error handling.
 */



/**
 * Request state enumeration
 */
export enum RequestState {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  TIMEOUT = 'timeout',
  ERROR = 'error',
  CANCELLED = 'cancelled'
}

/**
 * Request state entry
 */
interface StateEntry {
  state: RequestState;
  createdAt: number;
  lastTransition: number;
  transitionCount: number;
  metadata?: Record<string, unknown>;
}

/**
 * State transition event
 */
interface StateTransition {
  messageId: number;
  fromState: RequestState;
  toState: RequestState;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * State manager configuration
 */
interface StateManagerConfig {
  maxStates: number;
  enableHistory: boolean;
  historyLimit: number;
  cleanupInterval: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: StateManagerConfig = {
  maxStates: 10000,
  enableHistory: true,
  historyLimit: 1000,
  cleanupInterval: 60 * 1000, // 1 minute
};

/**
 * Request state manager with atomic operations
 * 
 * Provides thread-safe state management for JSON-RPC requests
 * with transition validation and history tracking.
 */
export class RequestStateManager {
  private states = new Map<number, StateEntry>();
  private locks = new Map<number, Promise<void>>();
  private history: StateTransition[] = [];
  private config: StateManagerConfig;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: Partial<StateManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startCleanupTimer();
  }

  /**
   * Initialize request state
   */
  async initialize(messageId: number, metadata?: Record<string, unknown>): Promise<boolean> {
    return this.transition(messageId, RequestState.PENDING, metadata);
  }

  /**
   * Transition request state atomically
   */
  async transition(
    messageId: number, 
    newState: RequestState, 
    metadata?: Record<string, unknown>
  ): Promise<boolean> {
    // Wait for any existing lock
    const existingLock = this.locks.get(messageId);
    if (existingLock) {
      await existingLock;
    }

    // Create new lock
    let resolveLock: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    this.locks.set(messageId, lockPromise);

    try {
      const currentEntry = this.states.get(messageId);
      const currentState = currentEntry?.state;

      // Validate transition
      if (currentState && !this.isValidTransition(currentState, newState)) {
        return false;
      }

      const now = Date.now();

      // Create or update state entry
      if (currentEntry) {
        // Record transition in history
        if (this.config.enableHistory) {
          this.addToHistory({
            messageId,
            fromState: currentEntry.state,
            toState: newState,
            timestamp: now,
            metadata,
          });
        }

        // Update existing entry
        currentEntry.state = newState;
        currentEntry.lastTransition = now;
        currentEntry.transitionCount++;
        if (metadata) {
          currentEntry.metadata = { ...currentEntry.metadata, ...metadata };
        }
      } else {
        // Create new entry
        this.states.set(messageId, {
          state: newState,
          createdAt: now,
          lastTransition: now,
          transitionCount: 1,
          metadata,
        });

        // Check size limit
        if (this.states.size > this.config.maxStates) {
          this.cleanupOldest();
        }
      }

      return true;
    } finally {
      // Release lock
      this.locks.delete(messageId);
      resolveLock!();
    }
  }

  /**
   * Get current state
   */
  getState(messageId: number): RequestState | undefined {
    return this.states.get(messageId)?.state;
  }

  /**
   * Get state entry with metadata
   */
  getStateEntry(messageId: number): StateEntry | undefined {
    return this.states.get(messageId);
  }

  /**
   * Check if request is in terminal state
   */
  isTerminal(messageId: number): boolean {
    const state = this.getState(messageId);
    return state ? this.isTerminalState(state) : false;
  }

  /**
   * Get all requests in specific state
   */
  getRequestsByState(state: RequestState): number[] {
    const result: number[] = [];
    for (const [messageId, entry] of this.states.entries()) {
      if (entry.state === state) {
        result.push(messageId);
      }
    }
    return result;
  }

  /**
   * Clean up request state
   */
  cleanup(messageId: number): boolean {
    const removed = this.states.delete(messageId);
    this.locks.delete(messageId);
    return removed;
  }

  /**
   * Validate state transition
   */
  private isValidTransition(currentState: RequestState, newState: RequestState): boolean {
    const validTransitions: Record<RequestState, RequestState[]> = {
      [RequestState.PENDING]: [
        RequestState.PROCESSING,
        RequestState.CANCELLED,
        RequestState.TIMEOUT,
        RequestState.ERROR
      ],
      [RequestState.PROCESSING]: [
        RequestState.COMPLETED,
        RequestState.ERROR,
        RequestState.CANCELLED,
        RequestState.TIMEOUT
      ],
      [RequestState.COMPLETED]: [], // Terminal state
      [RequestState.ERROR]: [], // Terminal state
      [RequestState.CANCELLED]: [], // Terminal state
      [RequestState.TIMEOUT]: [], // Terminal state
    };

    return validTransitions[currentState]?.includes(newState) ?? false;
  }

  /**
   * Check if state is terminal
   */
  private isTerminalState(state: RequestState): boolean {
    return [
      RequestState.COMPLETED,
      RequestState.ERROR,
      RequestState.CANCELLED,
      RequestState.TIMEOUT
    ].includes(state);
  }

  /**
   * Add transition to history
   */
  private addToHistory(transition: StateTransition): void {
    this.history.push(transition);
    
    // Limit history size
    if (this.history.length > this.config.historyLimit) {
      this.history.shift();
    }
  }

  /**
   * Get transition history for a request
   */
  getHistory(messageId?: number): StateTransition[] {
    if (messageId !== undefined) {
      return this.history.filter(t => t.messageId === messageId);
    }
    return [...this.history];
  }

  /**
   * Clean up oldest states when limit is reached
   */
  private cleanupOldest(): void {
    const entries = Array.from(this.states.entries());
    
    // Sort by creation time (oldest first)
    entries.sort((a, b) => a[1].createdAt - b[1].createdAt);
    
    // Remove oldest 10%
    const toRemove = Math.max(1, Math.floor(entries.length * 0.1));
    for (let i = 0; i < toRemove; i++) {
      this.states.delete(entries[i][0]);
    }
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
   * Periodic cleanup of terminal states
   */
  private periodicCleanup(): void {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes
    const toCleanup: number[] = [];

    for (const [messageId, entry] of this.states.entries()) {
      // Clean up terminal states older than maxAge
      if (this.isTerminalState(entry.state) && 
          now - entry.lastTransition > maxAge) {
        toCleanup.push(messageId);
      }
    }

    for (const messageId of toCleanup) {
      this.cleanup(messageId);
    }
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalStates: number;
    activeLocks: number;
    historySize: number;
    stateDistribution: Record<RequestState, number>;
  } {
    const stateDistribution: Record<RequestState, number> = {
      [RequestState.PENDING]: 0,
      [RequestState.PROCESSING]: 0,
      [RequestState.COMPLETED]: 0,
      [RequestState.TIMEOUT]: 0,
      [RequestState.ERROR]: 0,
      [RequestState.CANCELLED]: 0,
    };

    for (const entry of this.states.values()) {
      stateDistribution[entry.state]++;
    }

    return {
      totalStates: this.states.size,
      activeLocks: this.locks.size,
      historySize: this.history.length,
      stateDistribution,
    };
  }

  /**
   * Destroy state manager and cleanup resources
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    this.states.clear();
    this.locks.clear();
    this.history.length = 0;
  }
}

/**
 * Singleton state manager instance
 */
let globalStateManager: RequestStateManager | undefined;

/**
 * Get global state manager instance
 */
export function getStateManager(config?: Partial<StateManagerConfig>): RequestStateManager {
  if (!globalStateManager) {
    globalStateManager = new RequestStateManager(config);
  }
  return globalStateManager;
}
