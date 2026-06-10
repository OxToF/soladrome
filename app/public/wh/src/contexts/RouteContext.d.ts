import { default as React } from 'react';
import { Network, routes } from '@wormhole-foundation/sdk';
interface RouteContextType {
    route: routes.Route<Network> | null;
    receipt: routes.Receipt | null;
    setRoute: (route: routes.Route<Network>) => void;
    setReceipt: (receipt: routes.Receipt) => void;
    clear: () => void;
}
export declare const RouteContext: React.Context<RouteContextType>;
export declare const RouteProvider: React.FC<{
    children: React.ReactNode;
}>;
export {};
//# sourceMappingURL=RouteContext.d.ts.map