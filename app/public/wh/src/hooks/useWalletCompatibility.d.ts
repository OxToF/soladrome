import { Chain } from '@wormhole-foundation/sdk';
import { WalletData } from '../store/wallet';
export type WalletCompatibilityResult = {
    isCompatible: boolean;
    warning?: string;
};
export declare const useWalletCompatibility: ({ sendingWallet, receivingWallet, sourceChain, destChain, routes, }: {
    sendingWallet: WalletData;
    receivingWallet: WalletData;
    sourceChain?: Chain;
    destChain?: Chain;
    routes: string[];
}) => WalletCompatibilityResult;
//# sourceMappingURL=useWalletCompatibility.d.ts.map