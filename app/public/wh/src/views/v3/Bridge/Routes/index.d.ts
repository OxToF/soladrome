import { default as React } from 'react';
import { routes } from '@wormhole-foundation/sdk';
type Props = {
    routes: string[];
    selectedRoute?: string;
    onRouteChange: (route: string) => void;
    quotes: Record<string, routes.QuoteResult<routes.Options> | undefined>;
    isLoading: boolean;
    onManualGasChange: () => void;
};
declare function Routes({ routes: routesList, selectedRoute, onRouteChange, quotes, isLoading, onManualGasChange, }: Props): React.JSX.Element | null;
declare const _default: React.MemoExoticComponent<typeof Routes>;
export default _default;
//# sourceMappingURL=index.d.ts.map