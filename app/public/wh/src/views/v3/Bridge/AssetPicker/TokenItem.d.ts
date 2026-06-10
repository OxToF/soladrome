import { default as React } from 'react';
import { Token } from '../../../../config/tokens';
import { Chain, amount as sdkAmount } from '@wormhole-foundation/sdk';
type TokenItemProps = {
    token: Token;
    chain: Chain;
    balance: sdkAmount.Amount | null;
    price: string | null;
    onClick: () => void;
    isSelected?: boolean;
    isFetchingBalance?: boolean;
    isSource?: boolean;
    isDimmed?: boolean;
};
declare function TokenItem(props: TokenItemProps): React.JSX.Element;
declare const _default: React.MemoExoticComponent<typeof TokenItem>;
export default _default;
//# sourceMappingURL=TokenItem.d.ts.map