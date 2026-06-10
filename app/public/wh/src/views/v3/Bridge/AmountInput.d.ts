import { default as React } from 'react';
import { amount as sdkAmount } from '@wormhole-foundation/sdk';
import { Token } from '../../../config/tokens';
type Props = {
    value: string;
    debouncedValue: string;
    supportedSourceTokens: Array<Token>;
    tokenBalance: sdkAmount.Amount | null;
    receiveAmount?: number | undefined;
    error?: string;
    warning?: string;
    onChange: (value: string) => void;
    onDebouncedChange: (value: string) => void;
};
/**
 * Renders the input control to set the transaction amount
 */
declare function AmountInput(props: Props): React.JSX.Element;
declare const _default: React.MemoExoticComponent<typeof AmountInput>;
export default _default;
//# sourceMappingURL=AmountInput.d.ts.map