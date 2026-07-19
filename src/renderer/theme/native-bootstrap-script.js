(() => {
  try {
    const key = 'myagents:theme-bootstrap';
    const runKey = 'myagents:theme-native-bootstrap-run';
    const runId = __MYAGENTS_BOOTSTRAP_RUN_ID__;
    if (localStorage.getItem(runKey) === runId) return;

    let themeId = 'myagents-default';
    const raw = localStorage.getItem(key);

    if (raw) {
      try {
        const snapshot = JSON.parse(raw);
        if (
          snapshot
          && snapshot.version === 1
          && typeof snapshot.themeId === 'string'
          && snapshot.themeId.trim()
        ) {
          themeId = snapshot.themeId.trim();
        }
      } catch {
        // A damaged snapshot must not prevent durable appearance alignment.
      }
    }

    localStorage.setItem(key, JSON.stringify({
      version: 1,
      themeId,
      appearanceMode: __MYAGENTS_APPEARANCE_MODE__,
    }));
    // initialization_script runs again on reload. Mark this native process
    // only after the snapshot write succeeds, so a reload cannot overwrite a
    // newer appearance already published by ThemeRuntime.
    localStorage.setItem(runKey, runId);
    localStorage.removeItem('theme');
  } catch {
    // Private-mode or disabled storage must never block native startup.
  }
})();
