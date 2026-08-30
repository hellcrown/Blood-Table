import type { TableView } from '@shared/protocol';

export function LogPanel({ view }: { view: TableView }) {
  const lines = view.log.slice(-9);
  return (
    <div className="log-panel">
      {lines.map((l) => (
        <div key={l.seq} className={`log-line k-${l.kind}`}>
          {l.text}
        </div>
      ))}
    </div>
  );
}
