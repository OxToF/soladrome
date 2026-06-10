import { default as React } from 'react';
import { Chain } from '@wormhole-foundation/sdk';
import { ChainConfig } from '../../../../config/types';
import { WalletData } from '../../../../store/wallet';
import { Token } from '../../../../config/tokens';
import { Balances } from '../../../../utils/wallet/types';
interface AssetPickerDrawerProps {
    isDrawerOpen: boolean;
    setIsDrawerOpen: (value: boolean) => void;
    chainList: Array<ChainConfig>;
    chainConfig?: ChainConfig;
    showChainSearch: boolean;
    setShowChainSearch: (value: boolean) => void;
    wallet: WalletData;
    sortedTokens: Token[];
    balances: Balances;
    isFetchingBalances: boolean;
    isConnectingWallet?: boolean;
    isFetchingTokens?: boolean;
    isSameChainSwap: boolean;
    token?: Token;
    sourceToken?: Token;
    isSource: boolean;
    searchQuery: string;
    setSearchQuery: (value: string) => void;
    onChainSelect: (value: Chain) => void;
    onTokenSelect: (value: Token) => void;
}
declare function AssetPickerDrawer({ isDrawerOpen, setIsDrawerOpen, chainList, chainConfig, showChainSearch, setShowChainSearch, wallet, sortedTokens, balances, isFetchingBalances, isConnectingWallet, isFetchingTokens, isSameChainSwap, token, sourceToken, isSource, searchQuery, setSearchQuery, onChainSelect, onTokenSelect, }: AssetPickerDrawerProps): React.JSX.Element;
declare const _default: React.MemoExoticComponent<typeof AssetPickerDrawer>;
export default _default;
//# sourceMappingURL=PickerBottomSheet.d.ts.map