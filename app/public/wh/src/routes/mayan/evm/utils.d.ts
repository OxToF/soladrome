import { Network } from '@wormhole-foundation/sdk-connect';
import { TransactionRequest } from 'ethers';
declare function createMayanForwarderShim(): {
    encodeFunctionData: (forwarderData: string, payee: string, fee: bigint, tokenIn: string, amountIn: bigint, isNativeToken: boolean) => string;
    getMsgValue: (amountIn: bigint, isNativeToken: boolean) => bigint;
};
declare function getEvmContractAddress(network: Network, feeUnits: bigint, referrer?: string): string;
declare function createTransactionRequest(network: Network, mayanTxRequest: TransactionRequest, amountUnits: bigint, feeUnits: bigint, sender: string, tokenAddress: string, isNativeToken: boolean, referrer?: string): TransactionRequest;
export { createMayanForwarderShim, createTransactionRequest, getEvmContractAddress, };
//# sourceMappingURL=utils.d.ts.map