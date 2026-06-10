import { default as React } from 'react';
import { PopupState } from 'material-ui-popup-state/hooks';
import { Chain } from '@wormhole-foundation/sdk';
import { ChainConfig } from '../../../../config/types';
import { WalletData } from '../../../../store/wallet';
import { Token } from '../../../../config/tokens';
import { Balances } from '../../../../utils/wallet/types';
interface AssetPickerPopoverProps {
    popupState: PopupState;
    anchorEl: HTMLElement | null;
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
declare function AssetPickerPopover({ popupState, anchorEl, chainList, chainConfig, showChainSearch, setShowChainSearch, wallet, sortedTokens, balances, isFetchingBalances, isConnectingWallet, isFetchingTokens, isSameChainSwap, token, sourceToken, isSource, searchQuery, setSearchQuery, onChainSelect, onTokenSelect, }: AssetPickerPopoverProps): React.JSX.Element;
declare const _default: React.MemoExoticComponent<typeof AssetPickerPopover>;
export default _default;
//# sourceMappingURL=PickerModal.d.ts.map