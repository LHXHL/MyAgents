import type { Components } from 'react-markdown';
import TableActions from './TableActions';
import { tableSnapshotFromHast } from '@/utils/tableExport';

const MarkdownTable: Components['table'] = ({ children, node }) => (
  <div className="markdown-table max-w-full">
    <div className="markdown-table-scroll rounded-lg border border-[var(--line)]">
      <table className="m-0 min-w-full divide-y divide-[var(--line)]">{children}</table>
    </div>
    {node && <TableActions getSnapshot={() => tableSnapshotFromHast(node)} />}
  </div>
);
export default MarkdownTable;
