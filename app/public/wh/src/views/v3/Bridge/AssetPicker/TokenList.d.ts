import { default as React } from 'react';
import { ChainConfig } from '../../../../config/types';
import { Token } from '../../../../config/tokens';
import { WalletData } from '../../../../store/wallet';
import { Balances } from '../../../../utils/wallet/types';
type Props = {
    tokenList: Array<Token>;
    balances: Balances;
    isFetchingBalances: boolean;
    isFetching?: boolean;
    isConnectingWallet?: boolean;
    selectedChainConfig: ChainConfig;
    selectedToken?: Token;
    sourceToken?: Token;
    isSameChainSwap: boolean;
    isSource: boolean;
    wallet: WalletData;
    searchQuery: string;
    onSearchQueryChange: (query: string) => void;
    onSelectToken: (key: Token) => void;
    fetchTokensProgress?: null | number;
};
declare const _default: React.MemoExoticComponent<(props: Props) => React.JSX.Element>;
export default _default;
//# sourceMappingURL=TokenList.d.ts.map