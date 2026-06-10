import { WormholeConnectConfig, InternalConfig } from './types';
import { Wormhole as WormholeV2, Network } from '@wormhole-foundation/sdk';
export * from './types';
export declare function buildConfig(customConfig?: WormholeConnectConfig): InternalConfig<Network>;
declare const config: InternalConfig<"Mainnet" | "Testnet" | "Devnet">;
export default config;
export declare function getWormholeContextV2(): Promise<WormholeV2<Network>>;
export declare function clearWormholeContextV2(): Promise<void>;
export declare function newWormholeContextV2(): Promise<WormholeV2<Network>>;
export declare function setConfig(customConfig?: WormholeConnectConfig): void;
//# sourceMappingURL=index.d.ts.map