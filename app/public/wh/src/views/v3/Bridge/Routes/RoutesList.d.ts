import { default as React } from 'react';
import { routes } from '@wormhole-foundation/sdk';
type Props = {
    routesWithQuotes: string[];
    highlightedRoute?: string;
    quotes: Record<string, routes.QuoteResult<routes.Options> | undefined>;
    fastestRoute: {
        name: string;
        eta: number;
    };
    cheapestRoute: {
        name: string;
        amountOut: bigint;
    };
    isLoading?: boolean;
    onRouteSelect: (route: string) => void;
    onGasChange: (value: number) => void;
};
declare const _default: React.MemoExoticComponent<({ routesWithQuotes, highlightedRoute, quotes, fastestRoute, cheapestRoute, isLoading, onRouteSelect, onGasChange, }: Props) => React.JSX.Element>;
export default _default;
//# sourceMappingURL=RoutesList.d.ts.map