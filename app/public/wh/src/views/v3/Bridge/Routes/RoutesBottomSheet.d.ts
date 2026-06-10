import { default as React } from 'react';
import { routes } from '@wormhole-foundation/sdk';
interface RoutesMobileProps {
    open: boolean;
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
    selectButtonDisabled: boolean;
    isLoading?: boolean;
    onOpen: () => void;
    onClose: () => void;
    onGasChange: (value: number) => void;
    onRouteSelect: (route: string) => void;
    onRouteConfirm: () => void;
}
declare function RoutesMobile({ open, onOpen, onClose, routesWithQuotes, highlightedRoute, quotes, fastestRoute, cheapestRoute, selectButtonDisabled, isLoading, onRouteSelect, onGasChange, onRouteConfirm, }: RoutesMobileProps): React.JSX.Element;
declare const _default: React.MemoExoticComponent<typeof RoutesMobile>;
export default _default;
//# sourceMappingURL=RoutesBottomSheet.d.ts.map