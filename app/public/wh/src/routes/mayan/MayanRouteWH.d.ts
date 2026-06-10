import { Network } from '@wormhole-foundation/sdk-base';
import { routes } from '@wormhole-foundation/sdk-connect';
import { MayanRouteCrossChain } from './MayanRouteCrossChain';
import { MayanProtocol } from './types';
export declare class MayanRouteWH<N extends Network> extends MayanRouteCrossChain<N> implements routes.StaticRouteMethods<typeof MayanRouteWH> {
    static meta: {
        name: string;
        provider: string;
    };
    protocols: MayanProtocol[];
}
//# sourceMappingURL=MayanRouteWH.d.ts.map