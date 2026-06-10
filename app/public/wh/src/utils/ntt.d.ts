import { Chain, TokenId } from '@wormhole-foundation/sdk';
import { Token } from '../config/tokens';
export declare const nttRoutes: readonly ["ManualNtt", "M0AutomaticRoute", "NttExecutorRoute"];
export declare const isNttRoute: (routeName: string) => boolean;
interface NttTokenOption {
    chain: Chain;
    token: string;
}
type NttTokensConfig = Record<string, NttTokenOption[]>;
export declare const getNttTokens: (routeName: string) => NttTokensConfig | undefined;
export declare const isNttToken: (tokenId: TokenId) => boolean;
export declare const getNttTokenGroup: (tokenId: TokenId) => Token[];
export {};
//# sourceMappingURL=ntt.d.ts.map