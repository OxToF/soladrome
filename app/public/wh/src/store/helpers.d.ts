export type DataWrapper<T> = {
    data: T | null;
    error: any | null;
    isFetching: boolean;
    receivedAt: string | null;
};
export declare function getEmptyDataWrapper(): {
    data: null;
    error: null;
    isFetching: boolean;
    receivedAt: null;
};
export declare function receiveDataWrapper<T>(data: T): DataWrapper<T>;
export declare function errorDataWrapper<T>(error: string): DataWrapper<T>;
export declare function fetchDataWrapper(): {
    data: null;
    error: null;
    isFetching: boolean;
    receivedAt: null;
};
//# sourceMappingURL=helpers.d.ts.map