import { routes } from '@wormhole-foundation/sdk';
export declare const getBestRoutes: (routes: string[], quotes: Record<string, routes.QuoteResult<routes.Options> | undefined>) => {
    fastestRoute: {
        name: string;
        eta: number;
    };
    cheapestRoute: {
        name: string;
        amountOut: bigint;
    };
};
export declare function getDefaultQuoteExpiry(fromDate: number): Date;
export declare function getQuoteExpiry(expiryFromQuote?: Date): Date;
//# sourceMappingURL=routes.d.ts.map