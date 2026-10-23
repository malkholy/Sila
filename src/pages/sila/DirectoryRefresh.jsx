import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { loadDirectory, onDirectory } from '../../shared/chat.js';

// The people pickers and the cached directory (chat.js loadDirectory):
// useDirectoryVersion() changes when the directory reloads, so a picker
// searches again; DirectoryRefresh reloads it now (a new user, a changed title).
export function useDirectoryVersion() {
  const [version, setVersion] = useState(0);
  useEffect(() => onDirectory(() => setVersion(v => v + 1)), []);
  return version;
}

export default function DirectoryRefresh({ size = 30 }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const refresh = () => {
    setBusy(true); setFailed(false);
    loadDirectory({ force: true }).catch(() => setFailed(true)).finally(() => setBusy(false));
  };
  return (
    <button type="button" onClick={refresh} disabled={busy} aria-label="Refresh the people list"
      title={failed ? 'Could not refresh the people list. Try again.' : 'Refresh the people list'} style={{
        width: size, height: size, borderRadius: 8, border: 'none', background: 'transparent', flexShrink: 0,
        color: failed ? 'var(--red)' : 'var(--text2)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: busy ? 'wait' : 'pointer',
      }}><RefreshCw size={15} style={busy ? { animation: 'spin 1s linear infinite' } : undefined} /></button>
  );
}
