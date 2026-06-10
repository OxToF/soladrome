import { default as React } from 'react';
import { amount as sdkAmount } from '@wormhole-foundation/sdk';
declare const TokenBalance: ({ balance, isFetching, price, }: {
    balance: sdkAmount.Amount | null;
    isFetching?: boolean;
    price?: string | null;
}) => React.JSX.Element;
export default TokenBalance;
//# sourceMappingURL=TokenBalance.d.ts.map