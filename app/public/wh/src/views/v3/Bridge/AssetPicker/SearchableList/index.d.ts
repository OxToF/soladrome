import { ReactNode } from 'react';
import { SxProps, Theme } from '@mui/material';
type SearchableListProps<T> = {
    title?: ReactNode;
    listTitle?: ReactNode;
    searchPlaceholder?: string;
    className?: string;
    items: T[];
    loading?: ReactNode;
    dataTestId?: string;
    sx?: SxProps<Theme>;
    renderFn: (item: T, index: number) => ReactNode;
    filterFn?: (item: T, query: string) => boolean;
    onQueryChange: (query: string) => void;
    searchQuery: string;
};
declare function SearchableList<T>(props: SearchableListProps<T>): ReactNode;
declare const _default: typeof SearchableList;
export default _default;
//# sourceMappingURL=index.d.ts.map