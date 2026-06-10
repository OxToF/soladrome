import { Network } from '@wormhole-foundation/sdk-base';
import { routes } from '@wormhole-foundation/sdk-connect';
import { MayanRouteCrossChain } from './MayanRouteCrossChain';
import { MayanProtocol } from './types';
export declare class MayanRouteMCTP<N extends Network> extends MayanRouteCrossChain<N> implements routes.StaticRouteMethods<typeof MayanRouteMCTP> {
    static meta: {
        name: string;
        provider: string;
    };
    protocols: MayanProtocol[];
}
//# sourceMappingURL=MayanRouteMCTP.d.ts.map