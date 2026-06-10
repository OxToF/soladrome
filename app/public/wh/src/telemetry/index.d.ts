import { TokenDetails, TransferDetails } from './types';
import { Chain, amount as sdkAmount } from '@wormhole-foundation/sdk';
import { Token } from '../config/tokens';
export * from './types';
export declare function getTokenDetails(token: Token): TokenDetails;
export declare function getTransferDetails(route: string, sourceToken: Token, destToken: Token, sourceChain: Chain, destChain: Chain, amount: sdkAmount.Amount, getUSDAmount: (args: {
    token: Token;
    amount: sdkAmount.Amount;
}) => number | undefined): TransferDetails;
//# sourceMappingURL=index.d.ts.map