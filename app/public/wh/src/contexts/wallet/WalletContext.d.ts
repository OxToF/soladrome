import { Chain } from '@wormhole-foundation/sdk';
import { TransferWallet, Wallet, WormholeConnectWalletProvider } from '../../utils/wallet';
export interface WalletContextType {
    connectWallet: (chain: Chain, type: TransferWallet, autoConnect?: boolean) => Promise<Wallet | null>;
    disconnectWallet: (chain: Chain, type: TransferWallet) => void;
    clearWallets: () => void;
    swapWallets: () => void;
    walletProvider: WormholeConnectWalletProvider;
    isConnecting: boolean;
}
declare const WalletContext: import('react').Context<WalletContextType | undefined>;
export default WalletContext;
//# sourceMappingURL=WalletContext.d.ts.map