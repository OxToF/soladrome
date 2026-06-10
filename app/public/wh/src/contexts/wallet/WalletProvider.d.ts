import { ReactNode, default as React } from 'react';
import { WormholeConnectWalletProvider } from '../../utils/wallet';
export interface WalletProviderProps {
    children: ReactNode;
    provider: WormholeConnectWalletProvider;
}
declare function WalletProvider({ children, provider: walletProvider, }: WalletProviderProps): React.JSX.Element;
export default WalletProvider;
//# sourceMappingURL=WalletProvider.d.ts.map