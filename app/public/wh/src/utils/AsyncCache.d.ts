export declare class AsyncCache<T> {
    private TTLms;
    private cache;
    private pendingRequests;
    constructor(TTLms: number);
    requestWithCache(cacheKey: string, fetchFn: () => Promise<T>): Promise<T>;
}
//# sourceMappingURL=AsyncCache.d.ts.map