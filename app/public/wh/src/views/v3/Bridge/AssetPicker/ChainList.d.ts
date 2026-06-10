import { default as React } from 'react';
import { Chain } from '@wormhole-foundation/sdk';
import { ChainConfig } from '../../../../config/types';
import { WalletData } from '../../../../store/wallet';
type Props = {
    chainList?: ChainConfig[];
    selectedChainConfig?: ChainConfig;
    showSearch: boolean;
    setShowSearch: (value: boolean) => void;
    wallet: WalletData;
    onChainSelect: (chain: Chain) => void;
};
declare function ChainList(props: Props): React.JSX.Element;
declare const _default: React.MemoExoticComponent<typeof ChainList>;
export default _default;
//# sourceMappingURL=ChainList.d.ts.map