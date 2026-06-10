import { default as React } from 'react';
export interface RouteDetailsProps {
    destChain?: string;
    provider?: string;
    eta?: number;
    selectedRoute?: string;
    sourceChain?: string;
    handleToggleRoutes: () => void;
    quoteSlippageBps?: number;
    minReceived?: number;
    outputToken?: string;
}
export default function RouteDetails({ destChain, provider, eta, selectedRoute, handleToggleRoutes, sourceChain, quoteSlippageBps, minReceived, outputToken, }: RouteDetailsProps): React.JSX.Element;
//# sourceMappingURL=RouteDetails.d.ts.map