import { Network } from '@wormhole-foundation/sdk-base';
import { routes } from '@wormhole-foundation/sdk-connect';
import { MayanRouteBase } from './MayanRouteBase';
import { TransferParams, ValidationResult } from './types';
export declare abstract class MayanRouteCrossChain<N extends Network> extends MayanRouteBase<N> {
    validate(request: routes.RouteTransferRequest<N>, params: TransferParams): Promise<ValidationResult>;
}
//# sourceMappingURL=MayanRouteCrossChain.d.ts.map