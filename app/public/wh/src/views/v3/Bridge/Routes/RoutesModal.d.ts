import { default as React } from 'react';
import { routes } from '@wormhole-foundation/sdk';
interface RoutesDesktopProps {
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
    onClose: () => void;
    onGasChange: (value: number) => void;
    onRouteSelect: (route: string) => void;
    onRouteConfirm: () => void;
}
declare function RoutesDesktop({ open, onClose, routesWithQuotes, highlightedRoute, quotes, fastestRoute, cheapestRoute, selectButtonDisabled, isLoading, onRouteSelect, onGasChange, onRouteConfirm, }: RoutesDesktopProps): React.JSX.Element;
declare const _default: React.MemoExoticComponent<typeof RoutesDesktop>;
export default _default;
//# sourceMappingURL=RoutesModal.d.ts.map