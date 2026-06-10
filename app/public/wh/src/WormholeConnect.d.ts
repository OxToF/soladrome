import { WormholeConnectConfig } from './config/types';
import { WormholeConnectTheme } from 'theme';
import { WormholeConnectWalletProvider } from './utils/wallet/types';
import * as React from 'react';
export interface WormholeConnectProps {
    theme?: WormholeConnectTheme;
    config?: WormholeConnectConfig;
    walletProvider?: WormholeConnectWalletProvider;
}
export default function WormholeConnect({ config, theme, walletProvider: externalProvider, }: WormholeConnectProps): React.JSX.Element;
//# sourceMappingURL=WormholeConnect.d.ts.map