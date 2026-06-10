/**
 * Calls a given function and keeps calling it after the specified delay has passed.
 */
export declare const poll: (fn: () => Promise<void>, delayOrDelayCallback: number | (() => number), shouldStopPolling: () => boolean | Promise<boolean>) => Promise<void>;
//# sourceMappingURL=polling.d.ts.map