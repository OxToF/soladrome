import { routes } from '@wormhole-foundation/sdk-connect';
import { Network } from '@wormhole-foundation/sdk-base';
import { MayanProtocol } from './types';
import { MayanRouteCrossChain } from './MayanRouteCrossChain';
export declare class MayanRouteFastMCTP<N extends Network> extends MayanRouteCrossChain<N> implements routes.StaticRouteMethods<typeof MayanRouteFastMCTP> {
    static meta: {
        name: string;
        provider: string;
    };
    protocols: MayanProtocol[];
}
//# sourceMappingURL=MayanRouteFastMCTP.d.ts.map