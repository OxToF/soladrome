import { default as React } from 'react';
import { Chain } from '@wormhole-foundation/sdk';
import { ChainConfig } from '../../../../config/types';
type ChainShortListProps = {
    chains: ChainConfig[];
    selectedChain?: ChainConfig;
    showMoreButton: boolean;
    onChainSelect: (chain: Chain) => void;
    onShowMore: () => void;
};
declare function ChainShortList({ chains, selectedChain, showMoreButton, onChainSelect, onShowMore, }: ChainShortListProps): React.JSX.Element;
declare const _default: React.MemoExoticComponent<typeof ChainShortList>;
export default _default;
//# sourceMappingURL=ChainShortList.d.ts.map