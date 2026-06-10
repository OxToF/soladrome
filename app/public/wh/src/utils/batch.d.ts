export interface BatchConfig {
    batchSize: number;
    delayMs: number;
    maxItems?: number;
}
export declare function processBatches<T, R>(items: T[], processor: (item: T) => Promise<R>, config: BatchConfig): Promise<R[]>;
//# sourceMappingURL=batch.d.ts.map