import { default as React } from 'react';
import { routes, amount } from '@wormhole-foundation/sdk';
type Props = {
    route: string;
    isSelected: boolean;
    error?: string;
    destinationGasDrop?: amount.Amount;
    isFastest?: boolean;
    isCheapest?: boolean;
    isOnlyChoice?: boolean;
    isLoading?: boolean;
    quote?: routes.Quote<routes.Options>;
    onSelect?: (route: string) => void;
    onGasChange?: (nativeAmount: number) => void;
};
declare const _default: React.MemoExoticComponent<(props: Props) => React.JSX.Element>;
export default _default;
//# sourceMappingURL=SingleRoute.d.ts.map