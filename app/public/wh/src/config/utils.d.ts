import { ChainsConfig, WrappedTokenAddresses } from './types';
import { TokenCache } from './tokens';
import { Chain } from '@wormhole-foundation/sdk';
import { NttRoute } from '@wormhole-foundation/sdk-route-ntt';
import { DefaultInputs } from './ui';
export declare const populateRpcField: (chain: Chain, rpc: string | undefined) => {
    [x: string]: string;
};
export declare const mergeCustomWrappedTokens: (builtin: WrappedTokenAddresses, custom?: WrappedTokenAddresses) => WrappedTokenAddresses;
export declare const mergeNttConfig: (tokens: TokenCache, builtin: NttRoute.Config, custom?: NttRoute.Config) => NttRoute.Config;
export declare const validateDefaults: (defaults: DefaultInputs, chains: ChainsConfig, tokens: TokenCache) => DefaultInputs | undefined;
export declare const capitalize: (str: string) => string;
//# sourceMappingURL=utils.d.ts.map