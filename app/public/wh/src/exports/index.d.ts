import { default as WormholeConnect } from '../WormholeConnect';
import { WormholeConnectTheme } from '../theme';
import { default as MAINNET } from '../config/mainnet';
import { default as TESTNET } from '../config/testnet';
import { buildConfig } from '../config';
import { DEFAULT_ROUTES } from '../routes/operator';
import { routes, Chain, Network } from '@wormhole-foundation/sdk';
import { Token } from '../config/tokens';
import { TransferWallet } from '../utils/wallet';
import { Wallet, WalletConnectedHandler, WalletEvents, WalletProviderEvents, WormholeConnectWalletProvider } from '../utils/wallet/types';
export * as config from '../config/types';
export { cctpV2FastExecutorRoute, cctpV2StandardExecutorRoute, } from '@wormhole-labs/cctp-executor-route';
declare const CCTPRoute: typeof routes.CCTPRoute, TBTCRoute: typeof routes.TBTCRoute, executorTokenBridgeRoute: typeof routes.executorTokenBridgeRoute;
export default WormholeConnect;
export { MAINNET, TESTNET, buildConfig, Chain, Network, WormholeConnectTheme, Token, TransferWallet, Wallet, WalletEvents, WormholeConnectWalletProvider, WalletProviderEvents, WalletConnectedHandler, DEFAULT_ROUTES, CCTPRoute, TBTCRoute, executorTokenBridgeRoute, };
export * from '../telemetry';
//# sourceMappingURL=index.d.ts.map