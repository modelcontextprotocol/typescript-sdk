/**
 * Performance optimization tests for MCP protocol
 *
 * Tests the new serialization cache, resource management, and state management features.
 */

import { JSONSerializationCache, OptimizedJSON } from '../serialization.js';
import { ResourceManager, ResourceState } from '../resource-manager.js';
import { RequestStateManager, RequestState } from '../request-state.js';
import { JSONRPCRequest, JSONRPCResponse } from '../../types.js';

describe('JSON Serialization Cache', () => {
  let cache: JSONSerializationCache;

  beforeEach(() => {
    cache = JSONSerializationCache.getInstance();
    cache.clear();
  });

  afterEach(() => {
    cache.destroy();
  });

  it('should cache and reuse request templates', () => {
    const request1: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    };

    const request2: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    };

    const json1 = cache.serializeRequest(request1);
    const json2 = cache.serializeRequest(request2);

    expect(json1).toContain('"method":"tools/list"');
    expect(json2).toContain('"method":"tools/list"');
    
    // Should use cached template for same method pattern
    const stats = cache.getStats();
    expect(stats.templateCacheSize).toBeGreaterThan(0);
  });

  it('should handle requests with parameters', () => {
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'search',
        arguments: { query: 'test' }
      }
    };

    const json = cache.serializeRequest(request);
    expect(json).toContain('"params"');
    expect(json).toContain('"name":"search"');
  });

  it('should serialize responses efficiently', () => {
    const response: JSONRPCResponse = {
      jsonrpc: '2.0',
      id: 1,
      result: { data: 'test result' }
    };

    const json = cache.serializeResponse(response);
    expect(json).toContain('"result"');
    expect(json).toContain('"data":"test result"');
  });

  it('should provide performance statistics', () => {
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'test',
    };

    cache.serializeRequest(request);
    const stats = cache.getStats();

    expect(stats).toHaveProperty('cacheSize');
    expect(stats).toHaveProperty('templateCacheSize');
    expect(stats).toHaveProperty('maxEntries');
    expect(stats.templateCacheSize).toBeGreaterThan(0);
  });
});

describe('Resource Manager', () => {
  let resourceManager: ResourceManager;

  beforeEach(() => {
    resourceManager = new ResourceManager();
  });

  afterEach(() => {
    resourceManager.destroy();
  });

  it('should register and cleanup resources', () => {
    const messageId = 123;
    const responseHandler = () => {};
    const progressHandler = () => {};

    resourceManager.register(messageId, {
      responseHandler,
      progressHandler,
    });

    const resource = resourceManager.get(messageId);
    expect(resource).toBeDefined();
    expect(resource?.messageId).toBe(messageId);

    const cleaned = resourceManager.cleanup(messageId);
    expect(cleaned).toBe(true);

    const resourceAfterCleanup = resourceManager.get(messageId);
    expect(resourceAfterCleanup).toBeUndefined();
  });

  it('should update resource state atomically', async () => {
    const messageId = 123;
    
    resourceManager.register(messageId, {});
    
    const success = await resourceManager.updateState(messageId, ResourceState.PROCESSING);
    expect(success).toBe(true);

    const resource = resourceManager.get(messageId);
    expect(resource?.state).toBe(ResourceState.PROCESSING);
  });

  it('should prevent invalid state transitions', async () => {
    const messageId = 123;

    resourceManager.register(messageId, {});

    // First transition to processing (valid)
    await resourceManager.updateState(messageId, ResourceState.PROCESSING);

    // Then to completed (valid)
    await resourceManager.updateState(messageId, ResourceState.COMPLETED);

    // Should not allow transition from completed to processing (invalid)
    const success = await resourceManager.updateState(messageId, ResourceState.PROCESSING);
    expect(success).toBe(false);
  });

  it('should provide resource statistics', () => {
    const messageId = 123;
    resourceManager.register(messageId, {});

    const stats = resourceManager.getStats();
    expect(stats.activeResources).toBe(1);
    expect(stats.lockedResources).toBe(0);
    expect(stats).toHaveProperty('maxResources');
    expect(stats).toHaveProperty('memoryUsage');
  });

  it('should cleanup resources by state', async () => {
    const messageId1 = 123;
    const messageId2 = 124;

    resourceManager.register(messageId1, {});
    resourceManager.register(messageId2, {});

    // Transition through valid states
    await resourceManager.updateState(messageId1, ResourceState.PROCESSING);
    await resourceManager.updateState(messageId1, ResourceState.COMPLETED);

    await resourceManager.updateState(messageId2, ResourceState.PROCESSING);
    await resourceManager.updateState(messageId2, ResourceState.ERROR);

    const cleaned = resourceManager.cleanupByState(ResourceState.COMPLETED);
    expect(cleaned).toBe(1);

    expect(resourceManager.get(messageId1)).toBeUndefined();
    expect(resourceManager.get(messageId2)).toBeDefined();
  });
});

describe('Request State Manager', () => {
  let stateManager: RequestStateManager;

  beforeEach(() => {
    stateManager = new RequestStateManager();
  });

  afterEach(() => {
    stateManager.destroy();
  });

  it('should initialize and transition states', async () => {
    const messageId = 123;
    
    const initialized = await stateManager.initialize(messageId);
    expect(initialized).toBe(true);
    expect(stateManager.getState(messageId)).toBe(RequestState.PENDING);

    const transitioned = await stateManager.transition(messageId, RequestState.PROCESSING);
    expect(transitioned).toBe(true);
    expect(stateManager.getState(messageId)).toBe(RequestState.PROCESSING);
  });

  it('should validate state transitions', async () => {
    const messageId = 123;

    await stateManager.initialize(messageId);

    // Valid transition: PENDING -> PROCESSING
    await stateManager.transition(messageId, RequestState.PROCESSING);

    // Valid transition: PROCESSING -> COMPLETED
    await stateManager.transition(messageId, RequestState.COMPLETED);

    // Should not allow transition from completed to processing (invalid)
    const invalid = await stateManager.transition(messageId, RequestState.PROCESSING);
    expect(invalid).toBe(false);
    expect(stateManager.getState(messageId)).toBe(RequestState.COMPLETED);
  });

  it('should track terminal states', async () => {
    const messageId = 123;

    await stateManager.initialize(messageId);
    expect(stateManager.isTerminal(messageId)).toBe(false);

    // Valid transition: PENDING -> PROCESSING -> COMPLETED
    await stateManager.transition(messageId, RequestState.PROCESSING);
    expect(stateManager.isTerminal(messageId)).toBe(false);

    await stateManager.transition(messageId, RequestState.COMPLETED);
    expect(stateManager.isTerminal(messageId)).toBe(true);
  });

  it('should provide state statistics', async () => {
    const messageId1 = 123;
    const messageId2 = 124;
    
    await stateManager.initialize(messageId1);
    await stateManager.initialize(messageId2);
    await stateManager.transition(messageId1, RequestState.PROCESSING);

    const stats = stateManager.getStats();
    expect(stats.totalStates).toBe(2);
    expect(stats.stateDistribution[RequestState.PENDING]).toBe(1);
    expect(stats.stateDistribution[RequestState.PROCESSING]).toBe(1);
  });

  it('should maintain transition history', async () => {
    const messageId = 123;
    
    await stateManager.initialize(messageId, { method: 'test' });
    await stateManager.transition(messageId, RequestState.PROCESSING);
    await stateManager.transition(messageId, RequestState.COMPLETED);

    const history = stateManager.getHistory(messageId);
    expect(history.length).toBeGreaterThan(0);
    
    const lastTransition = history[history.length - 1];
    expect(lastTransition.toState).toBe(RequestState.COMPLETED);
  });

  it('should get requests by state', async () => {
    const messageId1 = 123;
    const messageId2 = 124;
    
    await stateManager.initialize(messageId1);
    await stateManager.initialize(messageId2);
    await stateManager.transition(messageId1, RequestState.PROCESSING);

    const pendingRequests = stateManager.getRequestsByState(RequestState.PENDING);
    const processingRequests = stateManager.getRequestsByState(RequestState.PROCESSING);

    expect(pendingRequests).toContain(messageId2);
    expect(processingRequests).toContain(messageId1);
  });
});

describe('OptimizedJSON', () => {
  it('should stringify JSON-RPC messages', () => {
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'test',
    };

    const json = OptimizedJSON.stringify(request);
    expect(json).toContain('"jsonrpc":"2.0"');
    expect(json).toContain('"method":"test"');
  });

  it('should parse JSON-RPC messages', () => {
    const json = '{"jsonrpc":"2.0","id":1,"method":"test"}';
    const parsed = OptimizedJSON.parse(json);
    
    expect(parsed).toHaveProperty('jsonrpc', '2.0');
    expect(parsed).toHaveProperty('id', 1);
    expect(parsed).toHaveProperty('method', 'test');
  });

  it('should handle parse errors gracefully', () => {
    const invalidJson = '{"invalid": json}';
    
    expect(() => OptimizedJSON.parse(invalidJson)).toThrow();
  });
});
