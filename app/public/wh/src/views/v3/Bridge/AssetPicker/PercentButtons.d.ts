import { default as React } from 'react';
import { Chain, amount as sdkAmount } from '@wormhole-foundation/sdk';
type Props = {
    tokenBalance: sdkAmount.Amount | null;
    chain?: Chain;
    isTransactionInProgress: boolean;
    selectedPercent: number;
    onAmountChange: (amount: string) => void;
    onDebouncedAmountChange: (amount: string) => void;
    onPercentSelect: (percent: number) => void;
};
declare function PercentButtons(props: Props): React.JSX.Element;
declare const _default: React.MemoExoticComponent<typeof PercentButtons>;
export default _default;
//# sourceMappingURL=PercentButtons.d.ts.map