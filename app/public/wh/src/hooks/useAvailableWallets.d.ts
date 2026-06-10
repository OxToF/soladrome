import { Chain, Platform } from '@wormhole-foundation/sdk';
import { WalletData } from '../utils/wallet';
type WalletOptions = {
    state: 'result' | 'loading' | 'error';
    options?: WalletData[];
    error?: string;
};
type Props = {
    chain: Chain | undefined;
    supportedChains: Set<Platform>;
};
type ReturnProps = {
    walletOptionsResult: WalletOptions;
};
export declare const useAvailableWallets: (props: Props) => ReturnProps;
export {};
//# sourceMappingURL=useAvailableWallets.d.ts.map